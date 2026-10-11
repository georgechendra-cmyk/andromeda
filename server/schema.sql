-- Andromeda credits: run once with
--   npx wrangler d1 execute andromeda --remote --file schema.sql

CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	email TEXT UNIQUE NOT NULL,
	pass TEXT NOT NULL,
	balance_mc INTEGER NOT NULL DEFAULT 0, -- thousandths of a credit
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	method TEXT NOT NULL, -- qris | card | manual
	pack TEXT,
	amount REAL,
	currency TEXT,
	credits_mc INTEGER NOT NULL,
	status TEXT NOT NULL, -- pending | approved | rejected
	ref TEXT UNIQUE, -- the checkout's order id, so a webhook sent twice pays once
	note TEXT,
	created_at INTEGER NOT NULL,
	decided_at INTEGER
);

CREATE TABLE IF NOT EXISTS usage (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL,
	model TEXT,
	cost_usd REAL, -- what OpenRouter charged
	charged_mc INTEGER, -- what the user paid, in thousandths of a credit
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
	k TEXT PRIMARY KEY,
	v TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_user ON payments (user_id, created_at);
CREATE INDEX IF NOT EXISTS payments_status ON payments (status, created_at);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS usage_user ON usage (user_id, created_at);
