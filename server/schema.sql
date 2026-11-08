-- Andromeda credits: run once with
--   npx wrangler d1 execute andromeda --remote --file schema.sql

CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	email TEXT UNIQUE NOT NULL,
	pass TEXT NOT NULL,
	balance_mc INTEGER NOT NULL DEFAULT 0, -- thousandths of a credit (bought: packs, never expire)
	free_mc INTEGER NOT NULL DEFAULT 0, -- what's left in the plan's window (Free's or a bought plan's)
	free_reset_at INTEGER NOT NULL DEFAULT 0, -- when the window is full again (0 = full, the clock hasn't started)
	plan TEXT, -- a bought plan (plus, max), or NULL for Free
	plan_until INTEGER NOT NULL DEFAULT 0, -- when its month runs out
	week_mc INTEGER NOT NULL DEFAULT 0, -- spent from windows this week
	week_at INTEGER NOT NULL DEFAULT 0, -- when this week ends (0 = no week running)
	plan_mc INTEGER NOT NULL DEFAULT 0, -- what's left of a bought plan's credits for this month (they don't carry over)
	period_at INTEGER NOT NULL DEFAULT 0, -- when this month of the plan ends and the next month's credits arrive
	email_ok INTEGER NOT NULL DEFAULT 0, -- someone has proven the email is theirs (a code sent to it, or Google)
	created_at INTEGER NOT NULL
);
-- (an older database gets plan, plan_until, week_mc, week_at, plan_mc, email_ok and period_at added by the server itself)

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
	in_tok INTEGER NOT NULL DEFAULT 0, -- tokens read
	cached_tok INTEGER NOT NULL DEFAULT 0, -- of those, read from the cache (cheaper, when the gateway passes it on)
	out_tok INTEGER NOT NULL DEFAULT 0, -- tokens written (thinking included)
	created_at INTEGER NOT NULL,
	ms INTEGER NOT NULL DEFAULT 0, -- how long the call took in all
	first_ms INTEGER NOT NULL DEFAULT 0, -- until its first word (0: not streamed)
	write_tok INTEGER NOT NULL DEFAULT 0 -- of what it read, how much the gateway says it wrote to the cache
);

-- videos take minutes: what was held for each, settled once when it finishes
CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY, -- OpenRouter's job id
	user_id TEXT NOT NULL,
	model TEXT,
	reserve_mc INTEGER NOT NULL,
	from_free INTEGER NOT NULL DEFAULT 0, -- how much of what was held were free credits
	settled INTEGER NOT NULL DEFAULT 0,
	owner INTEGER NOT NULL DEFAULT 0, -- started on the owner's computer (the owner key): nothing was held
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
	member TEXT, -- the Celestin Together teammate keeping it going (null: Celestin's own)
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

-- Andromeda's own measurements: for each very specific skill (a tag like "rust-lifetimes" or "kids-9") and model, how
-- often its piece of a checked answer held up. Only topic words and pass/fail, never what anyone wrote.
CREATE TABLE IF NOT EXISTS skill_stats (
	tag TEXT NOT NULL,
	model TEXT NOT NULL,
	ok INTEGER NOT NULL DEFAULT 0,
	n INTEGER NOT NULL DEFAULT 0,
	at INTEGER,
	PRIMARY KEY (tag, model)
);
-- how many results each account added today (so nobody can flood them)
CREATE TABLE IF NOT EXISTS skill_days (
	user_id TEXT NOT NULL,
	day TEXT NOT NULL,
	n INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (user_id, day)
);

-- help requests: what someone wrote, its number, and whether it's solved (deleted with the account)
CREATE TABLE IF NOT EXISTS support (
	id TEXT PRIMARY KEY, -- six digits: the number people quote
	user_id TEXT,
	email TEXT NOT NULL,
	category TEXT,
	subject TEXT,
	message TEXT NOT NULL,
	details TEXT,
	status TEXT NOT NULL DEFAULT 'open', -- open | solved
	ip TEXT, -- a hash, to keep floods out
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS support_user ON support (user_id, created_at);

-- pictures shared with an app the user connected (it fetches them from a link): deleted after a day
CREATE TABLE IF NOT EXISTS uploads (
	id TEXT PRIMARY KEY, -- 96 random hex characters: the link
	user_id TEXT NOT NULL,
	type TEXT NOT NULL,
	data BLOB NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_user ON uploads (user_id, created_at);

-- (no longer read: prices and the shop are in worker.js)
CREATE TABLE IF NOT EXISTS config (
	k TEXT PRIMARY KEY,
	v TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_user ON payments (user_id, created_at);
CREATE INDEX IF NOT EXISTS payments_status ON payments (status, created_at);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS usage_user ON usage (user_id, created_at);

-- Celestin Together's Front desk: a receptionist on a link the owner shares, its chats, and what it passes on
CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, intro TEXT, brief TEXT NOT NULL, models TEXT, cap_mc INTEGER NOT NULL DEFAULT 200000, day TEXT, day_mc INTEGER NOT NULL DEFAULT 0, tz INTEGER NOT NULL DEFAULT 420, active INTEGER NOT NULL DEFAULT 1, slots TEXT, cc TEXT, voice TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS bots_user ON bots (user_id);
CREATE TABLE IF NOT EXISTS bot_msgs (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, visitor TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, ip TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS bot_msgs_v ON bot_msgs (bot_id, visitor, created_at);
CREATE INDEX IF NOT EXISTS bot_msgs_ip ON bot_msgs (bot_id, ip, created_at);
CREATE TABLE IF NOT EXISTS bot_items (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, user_id TEXT NOT NULL, visitor TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT, details TEXT, status TEXT NOT NULL DEFAULT 'new', slot TEXT, slot_at INTEGER, reminded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS bot_items_user ON bot_items (user_id, status, created_at);

-- Celestin Together's jobs that run by themselves (win-back messages, marketing posts) and what they make
CREATE TABLE IF NOT EXISTS team_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL, models TEXT, state TEXT, next_at INTEGER NOT NULL, last_at INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS team_jobs_due ON team_jobs (active, next_at);
CREATE INDEX IF NOT EXISTS team_jobs_user ON team_jobs (user_id);
CREATE TABLE IF NOT EXISTS team_job_items (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, text TEXT NOT NULL, link TEXT, why TEXT, status TEXT NOT NULL DEFAULT 'ready', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS team_job_items_user ON team_job_items (user_id, status, created_at);

-- Celestin Together's agents: any job, described in words, run by the server on a schedule
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, goal TEXT NOT NULL, every_min INTEGER NOT NULL DEFAULT 60, sources TEXT, notify TEXT, email INTEGER NOT NULL DEFAULT 0, models TEXT, state TEXT, next_at INTEGER NOT NULL, last_at INTEGER, active INTEGER NOT NULL DEFAULT 1, spent_mc INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, tz INTEGER NOT NULL DEFAULT 420, act TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agents_due ON agents (active, next_at);
CREATE INDEX IF NOT EXISTS agents_user ON agents (user_id);
CREATE TABLE IF NOT EXISTS agent_log (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS agent_log_user ON agent_log (user_id, created_at);
CREATE INDEX IF NOT EXISTS agent_log_agent ON agent_log (agent_id, created_at);

-- accounts each person connected (Telegram, Discord, Bluesky, X): their own, encrypted with the server's CONN_KEY
CREATE TABLE IF NOT EXISTS conns (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, secret TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL, UNIQUE (user_id, kind));

-- phone calls placed for a business through its own Twilio account, turn by turn
CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, job_id TEXT, to_num TEXT NOT NULL, name TEXT, purpose TEXT NOT NULL, lang TEXT, models TEXT, turns TEXT, status TEXT NOT NULL DEFAULT 'calling', outcome TEXT, sid TEXT, created_at INTEGER NOT NULL, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS calls_user ON calls (user_id, created_at);

-- a person's settings (act without asking)
CREATE TABLE IF NOT EXISTS prefs (user_id TEXT PRIMARY KEY, state TEXT, updated_at INTEGER);
