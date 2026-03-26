# echo-reddit-monitor

> Keyword-driven Reddit surveillance with AI sentiment analysis, threshold-based alerting, and intelligence digest generation.

## Overview

Echo Reddit Monitor watches configurable subreddits for posts matching keyword lists, performs AI-powered sentiment analysis on matches, and generates alerts when posts exceed score thresholds or exhibit strongly negative sentiment. Results are stored in D1 with full query support. AI-generated intelligence digests summarize findings and are broadcast to the Shared Brain and MoltBook.

Ships with 6 default monitoring targets: r/cybersecurity, r/netsec, r/technology, r/cryptocurrency, r/oilandgas, and r/realestate, each with domain-specific keyword lists and alert thresholds.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check with monitored subreddit count, total posts, and alert count |
| `GET` | `/stats` | Detailed statistics: posts by subreddit, sentiment breakdown, 24h alerts, digest count |
| `POST` | `/monitor/add` | Add a subreddit to monitor. Body: `{subreddit, keywords[], alert_threshold?}` |
| `POST` | `/monitor/remove` | Disable a monitored subreddit. Body: `{subreddit}` |
| `GET` | `/monitor/list` | List all monitored subreddits with keywords and enabled status |
| `POST` | `/scan` | Trigger a full scan of all enabled subreddits |
| `GET` | `/posts` | Query discovered posts. Filters: `subreddit`, `keyword`, `sentiment`, `since`, `limit` |
| `GET` | `/digest` | Retrieve the most recent intelligence digest |
| `POST` | `/digest/generate` | Generate an AI digest from recent posts. Query: `since` (ISO date) |
| `GET` | `/alerts` | Query alerts. Filters: `severity`, `since`, `limit`. Joins post data. |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_VERSION` | `1.0.0` | Version identifier |
| `REDDIT_USER_AGENT` | `EchoRedditMonitor/1.0 (by Echo Omega Prime)` | User-Agent for Reddit API requests |
| `SCAN_LIMIT` | `50` | Number of posts to fetch per subreddit per scan |
| `RATE_LIMIT_MS` | `2000` | Delay (ms) between subreddit fetches to respect rate limits |

### Bindings

| Binding | Type | Service/Resource |
|---------|------|------------------|
| `DB` | D1 Database | `echo-reddit-monitor` — posts, monitors, alerts, digests |
| `CACHE` | KV Namespace | Hot cache for latest scan results |
| `AI` | Workers AI | Llama 3.1 8B for sentiment analysis and digest generation |
| `BRAIN` | Service Binding | `echo-shared-brain` — broadcasts digests and high-severity alerts |
| `CHAT` | Service Binding | `echo-chat` — AI conversation integration |
| `SWARM` | Service Binding | `echo-swarm-brain` — MoltBook posting |

### Cron Triggers

| Schedule | Description |
|----------|-------------|
| `*/30 * * * *` | Scan all monitored subreddits every 30 minutes |
| `0 13 * * *` | Generate daily digest at 13:00 UTC (8am CST) |

## Deployment

```bash
cd O:\ECHO_OMEGA_PRIME\WORKERS\echo-reddit-monitor
npx wrangler deploy
```

## Architecture

Built on Hono with CORS. Uses Reddit's public JSON API (`/r/{subreddit}/new.json`) with no authentication required (just a User-Agent header). Each scan fetches the latest posts from monitored subreddits, matches them against keyword lists, and performs Workers AI sentiment analysis on matches. Posts are deduplicated by Reddit post ID. Alerts are generated when a post's score exceeds the configured threshold or sentiment is strongly negative (score <= -0.6). D1 stores 4 tables: `monitored_subreddits`, `reddit_posts`, `digests`, and `alerts` with indexes on subreddit, discovery time, sentiment, and alert creation date. Scan results are cached in KV with 1-hour TTL.
