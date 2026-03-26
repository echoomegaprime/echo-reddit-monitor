-- Schema for echo-reddit-monitor
-- D1 Database: echo-reddit-monitor (8c4e980f-b09f-4a39-89ab-4b699654e03c)
-- Auto-generated from src/index.ts
-- Run: npx wrangler d1 execute echo-reddit-monitor --remote --file=./schema.sql

DROP TABLE IF EXISTS alerts;
DROP TABLE IF EXISTS digests;
DROP TABLE IF EXISTS reddit_posts;
DROP TABLE IF EXISTS monitored_subreddits;

CREATE TABLE monitored_subreddits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subreddit TEXT NOT NULL UNIQUE,
  keywords TEXT NOT NULL DEFAULT '[]',
  alert_threshold INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE reddit_posts (
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
);

CREATE TABLE digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,
  content TEXT NOT NULL,
  post_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  subreddit TEXT NOT NULL,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_posts_subreddit ON reddit_posts(subreddit);
CREATE INDEX idx_posts_discovered ON reddit_posts(discovered_at);
CREATE INDEX idx_posts_sentiment ON reddit_posts(sentiment);
CREATE INDEX idx_alerts_created ON alerts(created_at);
