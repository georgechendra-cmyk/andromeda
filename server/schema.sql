-- Andromeda credits: run once with
--   npx wrangler d1 execute andromeda --remote --file schema.sql

CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	email TEXT UNIQUE NOT NULL,
	pass TEXT NOT NULL,
	balance_mc INTEGER NOT NULL DEFAULT 0, -- thousandths of a credit (bought)
	free_mc INTEGER NOT NULL DEFAULT 0, -- the free credits left this session
	free_reset_at INTEGER NOT NULL DEFAULT 0, -- when they're full again (0 = full, the clock hasn't started)
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

-- videos take minutes: what was held for each, settled once when it finishes
CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY, -- OpenRouter's job id
	user_id TEXT NOT NULL,
	model TEXT,
	reserve_mc INTEGER NOT NULL,
	from_free INTEGER NOT NULL DEFAULT 0, -- how much of what was held were free credits
	settled INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);

-- free credits handed out each day (UTC), every account together, kept under the daily cap
CREATE TABLE IF NOT EXISTS free_days (
	day TEXT PRIMARY KEY, -- 2026-10-25
	mc INTEGER NOT NULL DEFAULT 0
);

-- chats their owners chose to share: a read-only copy of the words, at a link nobody can guess
CREATE TABLE IF NOT EXISTS shares (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	title TEXT,
	data TEXT NOT NULL, -- the messages, as JSON
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shares_user ON shares (user_id, created_at);

-- scheduled tasks: something to do by itself (a daily news brief, a weekly reminder), and what each run answered
CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	title TEXT,
	prompt TEXT NOT NULL,
	every TEXT NOT NULL, -- once | hour | day | weekdays | week
	minute INTEGER NOT NULL DEFAULT 0, -- of the day, in the person's own time
	dow INTEGER NOT NULL DEFAULT 0, -- 0 Sunday .. 6 Saturday, for "week"
	tz INTEGER NOT NULL DEFAULT 0, -- the person's offset from UTC in minutes (UTC+7 = 420)
	web INTEGER NOT NULL DEFAULT 1,
	models TEXT, -- the models Andromeda picked for it, best first (JSON)
	active INTEGER NOT NULL DEFAULT 1,
	next_at INTEGER NOT NULL,
	last_at INTEGER,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks (active, next_at);
CREATE INDEX IF NOT EXISTS tasks_user ON tasks (user_id);
CREATE TABLE IF NOT EXISTS task_runs (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	text TEXT,
	error TEXT,
	model TEXT,
	created_at INTEGER NOT NULL,
	seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS task_runs_user ON task_runs (user_id, created_at);

CREATE TABLE IF NOT EXISTS config (
	k TEXT PRIMARY KEY,
	v TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_user ON payments (user_id, created_at);
CREATE INDEX IF NOT EXISTS payments_status ON payments (status, created_at);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS usage_user ON usage (user_id, created_at);
