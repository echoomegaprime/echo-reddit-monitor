import { Hono } from "hono";
import { cors } from "hono/cors";

// ---------------------------------------------------------------------------
// Structured Logging
// ---------------------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, worker: 'echo-reddit-monitor', message, ...data };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  AI: Ai;
  BRAIN: Fetcher;
  CHAT: Fetcher;
  SWARM: Fetcher;
  KNOWLEDGE_FORGE: Fetcher;
  WORKER_VERSION: string;
  REDDIT_USER_AGENT: string;
  SCAN_LIMIT: string;
  RATE_LIMIT_MS: string;
  // Reddit OAuth2 credentials (password grant)
  REDDIT_CLIENT_ID: string;
  REDDIT_CLIENT_SECRET: string;
  REDDIT_USERNAME: string;
  REDDIT_PASSWORD: string;
}

interface MonitorTarget {
  id?: number;
  subreddit: string;
  keywords: string[];
  alert_threshold: number;
  enabled: boolean;
  created_at?: string;
}

interface RedditPost {
  id?: number;
  subreddit: string;
  post_id: string;
  title: string;
  author: string;
  content: string;
  url: string;
  score: number;
  num_comments: number;
  sentiment: string;
  sentiment_score: number;
  matched_keywords: string[];
  discovered_at?: string;
  created_utc: number;
}

interface RedditListingChild {
  kind: string;
  data: {
    id: string;
    name: string;
    title: string;
    author: string;
    selftext: string;
    url: string;
    permalink: string;
    score: number;
    num_comments: number;
    created_utc: number;
    subreddit: string;
    is_self: boolean;
  };
}

interface RedditListing {
  kind: string;
  data: {
    children: RedditListingChild[];
    after: string | null;
  };
}

// ---------------------------------------------------------------------------
// Schema & Seed Data
// ---------------------------------------------------------------------------

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS monitored_subreddits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subreddit TEXT NOT NULL UNIQUE,
    keywords TEXT NOT NULL DEFAULT '[]',
    alert_threshold INTEGER NOT NULL DEFAULT 100,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS reddit_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subreddit TEXT NOT NULL,
    post_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    num_comments INTEGER NOT NULL DEFAULT 0,
    sentiment TEXT NOT NULL DEFAULT 'neutral',
    sentiment_score REAL NOT NULL DEFAULT 0.0,
    matched_keywords TEXT NOT NULL DEFAULT '[]',
    discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_utc INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS digests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL,
    content TEXT NOT NULL,
    post_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT NOT NULL,
    subreddit TEXT NOT NULL,
    reason TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_posts_subreddit ON reddit_posts(subreddit)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_discovered ON reddit_posts(discovered_at)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_sentiment ON reddit_posts(sentiment)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at)`,
];

const DEFAULT_MONITORS: MonitorTarget[] = [
  {
    subreddit: "cybersecurity",
    keywords: ["breach", "leak", "vulnerability", "exploit", "ransomware"],
    alert_threshold: 200,
    enabled: true,
  },
  {
    subreddit: "netsec",
    keywords: ["CVE", "zero-day", "malware", "APT"],
    alert_threshold: 150,
    enabled: true,
  },
  {
    subreddit: "technology",
    keywords: ["AI", "artificial intelligence", "machine learning", "automation"],
    alert_threshold: 500,
    enabled: true,
  },
  {
    subreddit: "cryptocurrency",
    keywords: ["bitcoin", "ethereum", "DeFi", "hack", "rugpull"],
    alert_threshold: 300,
    enabled: true,
  },
  {
    subreddit: "oilandgas",
    keywords: ["permian basin", "drilling", "production", "midland", "Texas"],
    alert_threshold: 50,
    enabled: true,
  },
  {
    subreddit: "realestate",
    keywords: ["mineral rights", "title", "deed", "property"],
    alert_threshold: 100,
    enabled: true,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureSchema(db: D1Database): Promise<void> {
  const marker = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='monitored_subreddits'")
    .first<{ name: string }>();

  if (!marker) {
    for (const sql of SCHEMA_SQL) {
      await db.prepare(sql).run();
    }

    for (const m of DEFAULT_MONITORS) {
      await db
        .prepare(
          "INSERT OR IGNORE INTO monitored_subreddits (subreddit, keywords, alert_threshold, enabled) VALUES (?, ?, ?, ?)"
        )
        .bind(m.subreddit, JSON.stringify(m.keywords), m.alert_threshold, m.enabled ? 1 : 0)
        .run();
    }
  }

  // Migration: add forge tracking column if missing (runs every time)
  await ensureForgeColumn(db);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function matchesKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Reddit OAuth2 Token Acquisition
// ---------------------------------------------------------------------------

const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API_BASE = "https://oauth.reddit.com";

async function getRedditToken(env: Env): Promise<string> {
  // Check KV cache first
  const cached = await env.CACHE.get("reddit_access_token");
  if (cached) return cached;

  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) {
    throw new Error("REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET secrets not set");
  }

  const basicAuth = btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`);

  // Try password grant (script-type app)
  if (env.REDDIT_USERNAME && env.REDDIT_PASSWORD) {
    try {
      const resp = await fetch(REDDIT_TOKEN_URL, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": env.REDDIT_USER_AGENT,
        },
        body: new URLSearchParams({
          grant_type: "password",
          username: env.REDDIT_USERNAME,
          password: env.REDDIT_PASSWORD,
        }).toString(),
      });

      const data: any = await resp.json();

      if (data.access_token && !data.error) {
        const ttl = Math.max((data.expires_in || 3600) - 120, 300);
        await env.CACHE.put("reddit_access_token", data.access_token, { expirationTtl: ttl });
        log("info", "Reddit OAuth2 token acquired via password grant", { ttl, username: env.REDDIT_USERNAME });
        return data.access_token;
      }

      log("error", "Reddit OAuth2 password grant failed", {
        error: data.error,
        message: data.message || data.error_description || "",
      });
    } catch (e) {
      log("error", "Reddit OAuth2 password grant request error", { error: (e as Error)?.message });
    }
  }

  // Fallback: client_credentials grant (app-only, read-only — better than nothing)
  try {
    const resp = await fetch(REDDIT_TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": env.REDDIT_USER_AGENT,
      },
      body: "grant_type=client_credentials",
    });

    const data: any = await resp.json();

    if (data.access_token && !data.error) {
      const ttl = Math.max((data.expires_in || 3600) - 120, 300);
      await env.CACHE.put("reddit_access_token", data.access_token, { expirationTtl: ttl });
      log("info", "Reddit OAuth2 token acquired via client_credentials grant", { ttl });
      return data.access_token;
    }

    log("error", "Reddit OAuth2 client_credentials grant failed", {
      error: data.error,
      message: data.message || data.error_description || "",
    });
  } catch (e) {
    log("error", "Reddit OAuth2 client_credentials request error", { error: (e as Error)?.message });
  }

  throw new Error("Failed to acquire Reddit OAuth2 token via any grant type");
}

// ---------------------------------------------------------------------------
// Knowledge Forge Integration
// ---------------------------------------------------------------------------

async function ensureForgeColumn(db: D1Database): Promise<void> {
  try {
    await db.prepare("ALTER TABLE reddit_posts ADD COLUMN ingested_to_forge INTEGER NOT NULL DEFAULT 0").run();
    log("info", "Added ingested_to_forge column to reddit_posts");
  } catch (e) {
    // Column already exists — expected on subsequent runs
  }
}

async function ingestToKnowledgeForge(post: any, env: Env): Promise<boolean> {
  try {
    const category = `REDDIT_${(post.subreddit || 'GENERAL').toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
    const resp = await env.KNOWLEDGE_FORGE.fetch(
      'https://knowledge-forge/ingest',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: post.title || 'Reddit Post',
          content: `[r/${post.subreddit}] ${post.title}\n\n${(post.content || post.selftext || post.body || '').substring(0, 40000)}`,
          category,
          tags: ['reddit', post.subreddit, ...(post.matched_keywords || [])].filter(Boolean).slice(0, 10),
          source_path: post.url || post.permalink || `reddit://${post.post_id || post.id}`,
        }),
      }
    );
    if (resp.ok) {
      log("info", "Ingested post to Knowledge Forge", { post_id: post.post_id || post.id, category });
    } else {
      const body = await resp.text().catch(() => '');
      log("warn", "Knowledge Forge ingest returned non-OK", { status: resp.status, body: body.slice(0, 200), post_id: post.post_id || post.id });
    }
    return resp.ok;
  } catch (e) {
    log("warn", "Knowledge Forge ingest failed", { error: (e as Error)?.message, post_id: post.post_id || post.id });
    return false;
  }
}

async function fetchSubreddit(
  subreddit: string,
  limit: number,
  userAgent: string,
  token: string
): Promise<RedditListingChild[]> {
  // Use oauth.reddit.com with bearer token — www.reddit.com returns 403 from CF Worker IPs
  const url = `${REDDIT_API_BASE}/r/${encodeURIComponent(subreddit)}/new?limit=${limit}&raw_json=1`;
  const resp = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "User-Agent": userAgent,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Reddit OAuth API returned ${resp.status} for r/${subreddit}: ${body.slice(0, 200)}`);
  }
  const listing: RedditListing = await resp.json();
  return listing?.data?.children ?? [];
}

async function analyzeSentiment(
  ai: Ai,
  text: string
): Promise<{ sentiment: string; score: number }> {
  if (!text || text.trim().length === 0) {
    return { sentiment: "neutral", score: 0.0 };
  }

  const truncated = text.slice(0, 1500);

  try {
    const result: any = await ai.run("@cf/meta/llama-3.1-8b-instruct" as keyof AiModels, {
      messages: [
        {
          role: "system",
          content:
            'You are a sentiment analysis engine. Respond ONLY with a JSON object: {"sentiment":"positive"|"negative"|"neutral"|"mixed","score":<float -1.0 to 1.0>}. No other text.',
        },
        {
          role: "user",
          content: `Analyze the sentiment of this text:\n\n${truncated}`,
        },
      ],
      max_tokens: 60,
      temperature: 0.1,
    });

    const raw = (result?.response ?? result?.result?.response ?? "").trim();
    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const validSentiments = ["positive", "negative", "neutral", "mixed"];
      const sentiment = validSentiments.includes(parsed.sentiment) ? parsed.sentiment : "neutral";
      const score = typeof parsed.score === "number" ? Math.max(-1, Math.min(1, parsed.score)) : 0;
      return { sentiment, score };
    }
  } catch (e) {
    log("warn", "Sentiment analysis AI call failed, falling back to neutral", { error: (e as Error)?.message || String(e) });
  }

  return { sentiment: "neutral", score: 0.0 };
}

async function generateDigestText(ai: Ai, posts: RedditPost[]): Promise<string> {
  if (posts.length === 0) return "No new posts discovered in the monitoring period.";

  const summaryLines = posts.slice(0, 40).map(
    (p) =>
      `[r/${p.subreddit}] (score:${p.score}, sentiment:${p.sentiment}) "${p.title}" — matched: ${(p.matched_keywords ?? []).join(", ")}`
  );

  try {
    const result: any = await ai.run("@cf/meta/llama-3.1-8b-instruct" as keyof AiModels, {
      messages: [
        {
          role: "system",
          content:
            "You are an intelligence analyst producing a concise daily digest of Reddit activity across multiple subreddits. Group findings by topic, highlight threats and opportunities, note sentiment trends. Be direct and structured using markdown headers and bullet points. Max 800 words.",
        },
        {
          role: "user",
          content: `Here are the ${posts.length} posts discovered:\n\n${summaryLines.join("\n")}`,
        },
      ],
      max_tokens: 1200,
      temperature: 0.4,
    });

    return result?.response ?? result?.result?.response ?? "Digest generation returned empty.";
  } catch (err: any) {
    return `Digest generation failed: ${err.message ?? "unknown error"}. ${posts.length} posts were discovered.`;
  }
}

// ---------------------------------------------------------------------------
// Core scanning logic
// ---------------------------------------------------------------------------

interface ScanResult {
  subreddit: string;
  fetched: number;
  matched: number;
  stored: number;
  alerts: number;
  errors: string[];
}

async function scanSubreddit(
  env: Env,
  target: MonitorTarget,
  token: string
): Promise<ScanResult> {
  const result: ScanResult = {
    subreddit: target.subreddit,
    fetched: 0,
    matched: 0,
    stored: 0,
    alerts: 0,
    errors: [],
  };

  try {
    const children = await fetchSubreddit(
      target.subreddit,
      parseInt(env.SCAN_LIMIT, 10) || 50,
      env.REDDIT_USER_AGENT,
      token
    );
    result.fetched = children.length;

    for (const child of children) {
      const post = child.data;
      const combinedText = `${post.title} ${post.selftext ?? ""}`;
      const matched = matchesKeywords(combinedText, target.keywords);
      if (matched.length === 0) continue;
      result.matched++;

      // Check duplicate
      const existing = await env.DB.prepare(
        "SELECT id FROM reddit_posts WHERE post_id = ?"
      )
        .bind(post.id)
        .first();
      if (existing) continue;

      // Sentiment analysis
      const { sentiment, score } = await analyzeSentiment(env.AI, combinedText.slice(0, 2000));

      // Store post
      await env.DB.prepare(
        `INSERT OR IGNORE INTO reddit_posts
          (subreddit, post_id, title, author, content, url, score, num_comments,
           sentiment, sentiment_score, matched_keywords, created_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          post.subreddit,
          post.id,
          post.title,
          post.author,
          (post.selftext ?? "").slice(0, 10000),
          `https://www.reddit.com${post.permalink}`,
          post.score,
          post.num_comments,
          sentiment,
          score,
          JSON.stringify(matched),
          post.created_utc
        )
        .run();
      result.stored++;

      // Best-effort ingest to Knowledge Forge
      const forgeOk = await ingestToKnowledgeForge(
        {
          post_id: post.id,
          subreddit: post.subreddit,
          title: post.title,
          content: (post.selftext ?? "").slice(0, 40000),
          url: `https://www.reddit.com${post.permalink}`,
          matched_keywords: matched,
        },
        env
      );
      if (forgeOk) {
        await env.DB.prepare("UPDATE reddit_posts SET ingested_to_forge = 1 WHERE post_id = ?")
          .bind(post.id)
          .run()
          .catch(() => {});
      }

      // Alert logic: score exceeds threshold OR strongly negative sentiment
      const shouldAlert =
        post.score >= target.alert_threshold || (sentiment === "negative" && score <= -0.6);
      if (shouldAlert) {
        const reasons: string[] = [];
        if (post.score >= target.alert_threshold) {
          reasons.push(`Score ${post.score} exceeds threshold ${target.alert_threshold}`);
        }
        if (sentiment === "negative" && score <= -0.6) {
          reasons.push(`Strongly negative sentiment (${score.toFixed(2)})`);
        }
        const severity =
          post.score >= target.alert_threshold * 3 || score <= -0.9 ? "high" : "medium";

        await env.DB.prepare(
          "INSERT INTO alerts (post_id, subreddit, reason, severity) VALUES (?, ?, ?, ?)"
        )
          .bind(post.id, post.subreddit, reasons.join("; "), severity)
          .run();
        result.alerts++;
      }
    }
  } catch (err: any) {
    result.errors.push(err.message ?? "Unknown scan error");
  }

  return result;
}

async function scanAll(env: Env): Promise<ScanResult[]> {
  await ensureSchema(env.DB);

  // Acquire OAuth token once for the entire scan batch
  let token: string;
  try {
    token = await getRedditToken(env);
  } catch (e) {
    log("error", "Failed to acquire Reddit token — aborting scan", { error: (e as Error)?.message });
    return [{ subreddit: "*", fetched: 0, matched: 0, stored: 0, alerts: 0, errors: [(e as Error)?.message ?? "Token acquisition failed"] }];
  }

  const { results: targets } = await env.DB.prepare(
    "SELECT * FROM monitored_subreddits WHERE enabled = 1"
  ).all<MonitorTarget & { id: number; keywords: string }>();

  const scanResults: ScanResult[] = [];
  const delayMs = parseInt(env.RATE_LIMIT_MS, 10) || 2000;

  for (const raw of targets ?? []) {
    const target: MonitorTarget = {
      ...raw,
      keywords: JSON.parse(raw.keywords as string),
    };
    const sr = await scanSubreddit(env, target, token);
    scanResults.push(sr);

    // Rate limit between subreddit fetches
    if (targets && targets.indexOf(raw) < targets.length - 1) {
      await sleep(delayMs);
    }
  }

  return scanResults;
}

// ---------------------------------------------------------------------------
// Hono App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));
// Security headers middleware
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-XSS-Protection', '1; mode=block');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});


// ---- Health ----
app.get("/", (c) => c.json({ service: 'echo-reddit-monitor', status: 'operational' }));

app.get("/health", async (c) => {
  await ensureSchema(c.env.DB);
  const postCount =
    (await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM reddit_posts").first<{ cnt: number }>())
      ?.cnt ?? 0;
  const subCount =
    (
      await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM monitored_subreddits").first<{
        cnt: number;
      }>()
    )?.cnt ?? 0;
  const alertCount =
    (await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM alerts").first<{ cnt: number }>())?.cnt ??
    0;

  const hasToken = !!(await c.env.CACHE.get("reddit_access_token"));
  const hasClientId = !!c.env.REDDIT_CLIENT_ID;
  const hasClientSecret = !!c.env.REDDIT_CLIENT_SECRET;
  const hasUsername = !!c.env.REDDIT_USERNAME;

  return c.json({
    status: "healthy",
    worker: "echo-reddit-monitor",
    version: c.env.WORKER_VERSION,
    monitored_subreddits: subCount,
    total_posts: postCount,
    total_alerts: alertCount,
    reddit_auth: {
      client_id_set: hasClientId,
      client_secret_set: hasClientSecret,
      username_set: hasUsername,
      token_cached: hasToken,
    },
    timestamp: new Date().toISOString(),
  });
});

// ---- Stats ----
app.get("/stats", async (c) => {
  await ensureSchema(c.env.DB);

  const totalPosts =
    (await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM reddit_posts").first<{ cnt: number }>())
      ?.cnt ?? 0;

  const last24h =
    (
      await c.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM reddit_posts WHERE discovered_at > datetime('now', '-1 day')"
      ).first<{ cnt: number }>()
    )?.cnt ?? 0;

  const { results: bySub } = await c.env.DB.prepare(
    "SELECT subreddit, COUNT(*) as cnt FROM reddit_posts GROUP BY subreddit ORDER BY cnt DESC"
  ).all<{ subreddit: string; cnt: number }>();

  const { results: bySentiment } = await c.env.DB.prepare(
    "SELECT sentiment, COUNT(*) as cnt FROM reddit_posts GROUP BY sentiment ORDER BY cnt DESC"
  ).all<{ sentiment: string; cnt: number }>();

  const { results: recentAlerts } = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM alerts WHERE created_at > datetime('now', '-1 day')"
  ).all<{ cnt: number }>();

  const digestCount =
    (await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM digests").first<{ cnt: number }>())
      ?.cnt ?? 0;

  return c.json({
    total_posts: totalPosts,
    posts_last_24h: last24h,
    alerts_last_24h: recentAlerts?.[0]?.cnt ?? 0,
    total_digests: digestCount,
    posts_by_subreddit: bySub ?? [],
    posts_by_sentiment: bySentiment ?? [],
  });
});

// ---- Monitor CRUD ----
app.post("/monitor/add", async (c) => {
  await ensureSchema(c.env.DB);
  const body = await c.req.json<{
    subreddit: string;
    keywords: string[];
    alert_threshold?: number;
  }>();

  if (!body.subreddit || !Array.isArray(body.keywords) || body.keywords.length === 0) {
    return c.json({ error: "subreddit (string) and keywords (string[]) are required" }, 400);
  }

  const sub = body.subreddit.replace(/^r\//, "").trim().toLowerCase();
  const threshold = body.alert_threshold ?? 100;

  try {
    await c.env.DB.prepare(
      "INSERT INTO monitored_subreddits (subreddit, keywords, alert_threshold, enabled) VALUES (?, ?, ?, 1)"
    )
      .bind(sub, JSON.stringify(body.keywords), threshold)
      .run();
  } catch (err: any) {
    if (err.message?.includes("UNIQUE")) {
      // Update existing
      await c.env.DB.prepare(
        "UPDATE monitored_subreddits SET keywords = ?, alert_threshold = ?, enabled = 1 WHERE subreddit = ?"
      )
        .bind(JSON.stringify(body.keywords), threshold, sub)
        .run();
      return c.json({ status: "updated", subreddit: sub, keywords: body.keywords, alert_threshold: threshold });
    }
    throw err;
  }

  return c.json({
    status: "added",
    subreddit: sub,
    keywords: body.keywords,
    alert_threshold: threshold,
  });
});

app.post("/monitor/remove", async (c) => {
  await ensureSchema(c.env.DB);
  const body = await c.req.json<{ subreddit: string }>();
  if (!body.subreddit) {
    return c.json({ error: "subreddit is required" }, 400);
  }
  const sub = body.subreddit.replace(/^r\//, "").trim().toLowerCase();

  await c.env.DB.prepare("UPDATE monitored_subreddits SET enabled = 0 WHERE subreddit = ?")
    .bind(sub)
    .run();

  return c.json({ status: "disabled", subreddit: sub });
});

app.get("/monitor/list", async (c) => {
  await ensureSchema(c.env.DB);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM monitored_subreddits ORDER BY subreddit"
  ).all();

  const monitors = (results ?? []).map((r: any) => ({
    ...r,
    keywords: JSON.parse(r.keywords),
    enabled: r.enabled === 1,
  }));

  return c.json({ monitors });
});

// ---- Scan ----
app.post("/scan", async (c) => {
  const scanResults = await scanAll(c.env);

  const totalFetched = scanResults.reduce((s, r) => s + r.fetched, 0);
  const totalMatched = scanResults.reduce((s, r) => s + r.matched, 0);
  const totalStored = scanResults.reduce((s, r) => s + r.stored, 0);
  const totalAlerts = scanResults.reduce((s, r) => s + r.alerts, 0);

  return c.json({
    status: "scan_complete",
    subreddits_scanned: scanResults.length,
    total_fetched: totalFetched,
    total_matched: totalMatched,
    new_posts_stored: totalStored,
    new_alerts: totalAlerts,
    details: scanResults,
    timestamp: new Date().toISOString(),
  });
});

// ---- Posts Query ----
app.get("/posts", async (c) => {
  await ensureSchema(c.env.DB);

  const subreddit = c.req.query("subreddit");
  const keyword = c.req.query("keyword");
  const sentiment = c.req.query("sentiment");
  const since = c.req.query("since"); // ISO date string
  const limitParam = c.req.query("limit");
  const limit = Math.min(parseInt(limitParam ?? "50", 10) || 50, 200);

  let sql = "SELECT * FROM reddit_posts WHERE 1=1";
  const binds: any[] = [];

  if (subreddit) {
    sql += " AND subreddit = ?";
    binds.push(subreddit.replace(/^r\//, "").toLowerCase());
  }
  if (keyword) {
    sql += " AND (title LIKE ? OR content LIKE ? OR matched_keywords LIKE ?)";
    const pattern = `%${keyword}%`;
    binds.push(pattern, pattern, pattern);
  }
  if (sentiment) {
    sql += " AND sentiment = ?";
    binds.push(sentiment);
  }
  if (since) {
    sql += " AND discovered_at >= ?";
    binds.push(since);
  }

  sql += " ORDER BY discovered_at DESC LIMIT ?";
  binds.push(limit);

  const stmt = c.env.DB.prepare(sql);
  const { results } = await (binds.length > 0 ? stmt.bind(...binds) : stmt).all();

  const posts = (results ?? []).map((r: any) => ({
    ...r,
    matched_keywords: JSON.parse(r.matched_keywords ?? "[]"),
  }));

  return c.json({ count: posts.length, posts });
});

// ---- Digest ----
app.get("/digest", async (c) => {
  await ensureSchema(c.env.DB);
  const latest = await c.env.DB.prepare(
    "SELECT * FROM digests ORDER BY created_at DESC LIMIT 1"
  ).first();

  if (!latest) {
    return c.json({ digest: null, message: "No digests generated yet. POST /digest/generate to create one." });
  }

  return c.json({ digest: latest });
});

app.post("/digest/generate", async (c) => {
  await ensureSchema(c.env.DB);

  const since = c.req.query("since") ?? new Date(Date.now() - 86400000).toISOString();

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM reddit_posts WHERE discovered_at >= ? ORDER BY score DESC LIMIT 100"
  )
    .bind(since)
    .all<RedditPost & { matched_keywords: string }>();

  const posts: RedditPost[] = (results ?? []).map((r: any) => ({
    ...r,
    matched_keywords: JSON.parse(r.matched_keywords ?? "[]"),
  }));

  const digestContent = await generateDigestText(c.env.AI, posts);

  const period = `${since.slice(0, 10)}_to_${new Date().toISOString().slice(0, 10)}`;

  await c.env.DB.prepare(
    "INSERT INTO digests (period, content, post_count) VALUES (?, ?, ?)"
  )
    .bind(period, digestContent, posts.length)
    .run();

  // Broadcast digest to Shared Brain
  try {
    await c.env.BRAIN.fetch("https://echo-shared-brain/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instance_id: "echo-reddit-monitor",
        role: "assistant",
        content: `REDDIT INTELLIGENCE DIGEST (${period}): ${posts.length} posts analyzed.\n\n${digestContent.slice(0, 2000)}`,
        importance: 6,
        tags: ["reddit", "digest", "intelligence"],
      }),
    });
  } catch (e) {
    log("warn", "Failed to broadcast digest to Shared Brain", { error: (e as Error)?.message || String(e) });
  }

  // Post to MoltBook
  try {
    await c.env.SWARM.fetch("https://echo-swarm-brain/moltbook/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        author_id: "echo-reddit-monitor",
        author_name: "Reddit Monitor",
        author_type: "agent",
        content: `Reddit Intelligence Digest: ${posts.length} posts across monitored subreddits. Key findings delivered.`,
        mood: "building",
        tags: ["reddit", "digest"],
      }),
    });
  } catch (e) {
    log("warn", "Failed to post digest to MoltBook", { error: (e as Error)?.message || String(e) });
  }

  return c.json({
    status: "digest_generated",
    period,
    post_count: posts.length,
    digest: digestContent,
  });
});

// ---- Knowledge Forge Sync ----
app.post("/forge-sync", async (c) => {
  await ensureSchema(c.env.DB);

  const limitParam = c.req.query("limit");
  const batchLimit = Math.min(parseInt(limitParam ?? "100", 10) || 100, 500);

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM reddit_posts WHERE ingested_to_forge = 0 ORDER BY discovered_at DESC LIMIT ?"
  )
    .bind(batchLimit)
    .all();

  const posts = results ?? [];
  let ingested = 0;
  let failed = 0;

  for (const row of posts) {
    const post: any = {
      ...row,
      matched_keywords: (() => { try { return JSON.parse((row as any).matched_keywords ?? '[]'); } catch { return []; } })(),
    };

    const ok = await ingestToKnowledgeForge(
      {
        post_id: post.post_id,
        subreddit: post.subreddit,
        title: post.title,
        content: post.content,
        url: post.url,
        matched_keywords: post.matched_keywords,
      },
      c.env
    );

    if (ok) {
      await c.env.DB.prepare("UPDATE reddit_posts SET ingested_to_forge = 1 WHERE post_id = ?")
        .bind(post.post_id)
        .run()
        .catch(() => {});
      ingested++;
    } else {
      failed++;
    }
  }

  log("info", "Forge sync batch completed", { total: posts.length, ingested, failed });

  return c.json({
    status: "forge_sync_complete",
    total_candidates: posts.length,
    ingested,
    failed,
    timestamp: new Date().toISOString(),
  });
});

// ---- Alerts ----
app.get("/alerts", async (c) => {
  await ensureSchema(c.env.DB);

  const severity = c.req.query("severity");
  const since = c.req.query("since");
  const limitParam = c.req.query("limit");
  const limit = Math.min(parseInt(limitParam ?? "50", 10) || 50, 200);

  let sql = "SELECT a.*, rp.title, rp.url, rp.score, rp.sentiment, rp.sentiment_score FROM alerts a LEFT JOIN reddit_posts rp ON a.post_id = rp.post_id WHERE 1=1";
  const binds: any[] = [];

  if (severity) {
    sql += " AND a.severity = ?";
    binds.push(severity);
  }
  if (since) {
    sql += " AND a.created_at >= ?";
    binds.push(since);
  }

  sql += " ORDER BY a.created_at DESC LIMIT ?";
  binds.push(limit);

  const stmt = c.env.DB.prepare(sql);
  const { results } = await (binds.length > 0 ? stmt.bind(...binds) : stmt).all();

  return c.json({ count: (results ?? []).length, alerts: results ?? [] });
});

// ---- Cron Handler ----
async function handleCron(event: ScheduledEvent, env: Env): Promise<void> {
  await ensureSchema(env.DB);

  const hour = new Date(event.scheduledTime).getUTCHours();
  const minute = new Date(event.scheduledTime).getUTCMinutes();

  // Daily digest at 13:00 UTC (8am CST)
  if (hour === 13 && minute === 0) {
    const since = new Date(Date.now() - 86400000).toISOString();
    const { results } = await env.DB.prepare(
      "SELECT * FROM reddit_posts WHERE discovered_at >= ? ORDER BY score DESC LIMIT 100"
    )
      .bind(since)
      .all<RedditPost & { matched_keywords: string }>();

    const posts: RedditPost[] = (results ?? []).map((r: any) => ({
      ...r,
      matched_keywords: JSON.parse(r.matched_keywords ?? "[]"),
    }));

    const digestContent = await generateDigestText(env.AI, posts);
    const period = `${since.slice(0, 10)}_to_${new Date().toISOString().slice(0, 10)}`;

    await env.DB.prepare(
      "INSERT INTO digests (period, content, post_count) VALUES (?, ?, ?)"
    )
      .bind(period, digestContent, posts.length)
      .run();

    // Broadcast digest
    try {
      await env.BRAIN.fetch("https://echo-shared-brain/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instance_id: "echo-reddit-monitor",
          role: "assistant",
          content: `DAILY REDDIT DIGEST (${period}): ${posts.length} posts.\n\n${digestContent.slice(0, 2000)}`,
          importance: 7,
          tags: ["reddit", "daily_digest", "intelligence"],
        }),
      });
    } catch (e) {
      log("warn", "Failed to broadcast daily digest to Shared Brain via cron", { error: (e as Error)?.message || String(e) });
    }

    return;
  }

  // Every 30 minutes: scan all subreddits
  const scanResults = await scanAll(env);

  const totalStored = scanResults.reduce((s, r) => s + r.stored, 0);
  const totalAlerts = scanResults.reduce((s, r) => s + r.alerts, 0);

  // Cache latest scan result
  await env.CACHE.put(
    "last_scan",
    JSON.stringify({
      timestamp: new Date().toISOString(),
      subreddits_scanned: scanResults.length,
      new_posts: totalStored,
      new_alerts: totalAlerts,
      details: scanResults,
    }),
    { expirationTtl: 3600 }
  );

  // If high-severity alerts found, notify Brain
  if (totalAlerts > 0) {
    const highAlerts = scanResults.filter((r) => r.alerts > 0);
    try {
      await env.BRAIN.fetch("https://echo-shared-brain/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instance_id: "echo-reddit-monitor",
          role: "assistant",
          content: `REDDIT ALERT: ${totalAlerts} new alert(s) from ${highAlerts.map((a) => `r/${a.subreddit}`).join(", ")}. ${totalStored} new posts stored.`,
          importance: 8,
          tags: ["reddit", "alert"],
        }),
      });
    } catch (e) {
      log("warn", "Failed to send alert notification to Shared Brain", { error: (e as Error)?.message || String(e) });
    }
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(handleCron(event, env));
  },
};
