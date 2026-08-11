import { describe, it, expect } from 'vitest';
import { app, timingSafeEqual, matchesKeywords } from '../src/index.js';

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('secret-value', 'secret-value')).toBe(true);
  });
  it('returns false for different strings of the same length', () => {
    expect(timingSafeEqual('secret-value', 'secret-vlaue')).toBe(false);
  });
  it('returns false for strings of different length', () => {
    expect(timingSafeEqual('short', 'a-much-longer-string')).toBe(false);
  });
  it('returns false when either side is missing', () => {
    expect(timingSafeEqual(undefined, 'x')).toBe(false);
    expect(timingSafeEqual('x', null)).toBe(false);
    expect(timingSafeEqual(undefined, undefined)).toBe(false);
  });
  it('returns false comparing against an empty string', () => {
    expect(timingSafeEqual('nonempty', '')).toBe(false);
  });
});

describe('matchesKeywords', () => {
  it('matches case-insensitively', () => {
    expect(matchesKeywords('A ZERO-DAY exploit was found', ['zero-day'])).toEqual(['zero-day']);
  });
  it('returns all matched keywords', () => {
    expect(matchesKeywords('breach and leak reported', ['breach', 'leak', 'ransomware'])).toEqual([
      'breach',
      'leak',
    ]);
  });
  it('returns an empty array when nothing matches', () => {
    expect(matchesKeywords('a quiet day', ['breach', 'leak'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Minimal fake D1/KV bindings — enough for the auth gate to be exercised
// without a real Cloudflare runtime. Routes protected by auth never reach
// these for the negative-control tests; the positive control (a correct
// key) needs `/health`'s DB reads to resolve.
// ---------------------------------------------------------------------------

function fakeDB() {
  return {
    prepare(sql: string) {
      const stmt = {
        bind: (..._args: unknown[]) => stmt,
        first: async () => {
          if (sql.includes('sqlite_master')) return { name: 'monitored_subreddits' };
          if (sql.includes('COUNT(*)')) return { cnt: 0 };
          return null;
        },
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
  };
}

function fakeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: fakeDB(),
    CACHE: { get: async () => null, put: async () => undefined },
    AI: { run: async () => ({ response: '' }) },
    BRAIN: { fetch: async () => new Response('{}') },
    CHAT: { fetch: async () => new Response('{}') },
    SWARM: { fetch: async () => new Response('{}') },
    KNOWLEDGE_FORGE: { fetch: async () => new Response('{}') },
    WORKER_VERSION: 'test',
    REDDIT_USER_AGENT: 'test-agent',
    SCAN_LIMIT: '50',
    RATE_LIMIT_MS: '2000',
    REDDIT_CLIENT_ID: '',
    REDDIT_CLIENT_SECRET: '',
    REDDIT_USERNAME: '',
    REDDIT_PASSWORD: '',
    ECHO_API_KEY: 'correct-horse-battery-staple',
    ...overrides,
  };
}

describe('auth gate', () => {
  it('allows the bare "/" liveness check with no key', async () => {
    const res = await app.fetch(new Request('https://worker/'), fakeEnv());
    expect(res.status).toBe(200);
  });

  it('rejects a protected route with no key (401)', async () => {
    const res = await app.fetch(new Request('https://worker/health'), fakeEnv());
    expect(res.status).toBe(401);
  });

  it('rejects a protected route with a wrong key (401)', async () => {
    const res = await app.fetch(
      new Request('https://worker/health', { headers: { 'X-Echo-API-Key': 'garbage' } }),
      fakeEnv()
    );
    expect(res.status).toBe(401);
  });

  it('fails closed (503) when ECHO_API_KEY is not configured', async () => {
    const res = await app.fetch(
      new Request('https://worker/health', { headers: { 'X-Echo-API-Key': 'anything' } }),
      fakeEnv({ ECHO_API_KEY: '' })
    );
    expect(res.status).toBe(503);
  });

  it('allows a protected route with the correct key (positive control)', async () => {
    const res = await app.fetch(
      new Request('https://worker/health', {
        headers: { 'X-Echo-API-Key': 'correct-horse-battery-staple' },
      }),
      fakeEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worker).toBe('echo-reddit-monitor');
  });

  it('blocks mutating endpoints without a key', async () => {
    const scanRes = await app.fetch(new Request('https://worker/scan', { method: 'POST' }), fakeEnv());
    expect(scanRes.status).toBe(401);

    const addRes = await app.fetch(
      new Request('https://worker/monitor/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subreddit: 'test', keywords: ['x'] }),
      }),
      fakeEnv()
    );
    expect(addRes.status).toBe(401);
  });
});
