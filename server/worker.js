// Andromeda credits server.
//
// Holds the owner's AI keys (secrets, never sent to a browser), keeps each user's credit balance, and charges every
// request. Models are reached through Cloudflare AI Gateway's Unified Billing (OpenAI, Anthropic, Google, xAI) or
// OpenRouter (see "the ways to a model"), each at the thinking effort it scored best at. Money only
// ever moves one way: a user pays first, credits appear, usage spends them. A request can never spend more than the
// user has, because its worst-case cost is reserved before it is sent and the unused part is refunded when the real
// cost comes back.
//
// 1 credit = creditUsd (default $0.01) of usage at Andromeda's prices. Andromeda's price is the model's list price
// times a multiplier that depends on how expensive the model is (cheap models carry a bigger multiple, top models a
// smaller one, so a big build never feels expensive). Everything is set from the admin page, nothing is hard-coded.

const DEFAULT_CONFIG = {
	creditUsd: 0.01,
	// the model's list price x this (2x to 3x: half or more of every sale is margin). Bands are by the model's output
	// price in dollars per million tokens.
	multipliers: { cheap: 3, mid: 2.5, top: 2, media: 2 },
	bands: { cheapBelow: 2, topFrom: 15 },
	// the most one answer may write, whatever the balance (a model asked to think gets room for that on top); only what's
	// written is charged, so this only keeps a long answer from being cut off
	maxTokens: 32000,
	// free credits for everyone signed in, spent before anything paid for, full again "hours" after the first one is
	// used; at most dailyCap of them handed out a day across every account (600 credits cost the owner $3 at most)
	free: { credits: 100, hours: 24, dailyCap: 600 },
	// round local prices, not exchange-rate conversions
	packs: [
		{ id: "starter", name: "Starter", credits: 500, bonus: 0, prices: { USD: 5, IDR: 79000, EUR: 5, GBP: 4, SGD: 7, AUD: 8 }, lemonVariant: "" },
		{ id: "plus", name: "Plus", credits: 1000, bonus: 100, popular: true, prices: { USD: 10, IDR: 159000, EUR: 10, GBP: 8, SGD: 13, AUD: 15 }, lemonVariant: "" },
		{ id: "pro", name: "Pro", credits: 2000, bonus: 400, prices: { USD: 20, IDR: 319000, EUR: 19, GBP: 16, SGD: 27, AUD: 30 }, lemonVariant: "" },
	],
	currencies: ["USD", "IDR", "EUR", "GBP", "SGD", "AUD"],
	// QRIS for rupiah: the owner's QR image (a URL, e.g. qris.png in the site) and the name it shows
	qris: { image: "", name: "" },
	// card / Apple Pay / PayPal for everyone else: a checkout page per pack (Lemon Squeezy, Paddle or Gumroad)
	checkout: { provider: "Lemon Squeezy", links: { starter: "", plus: "", pro: "" } },
	support: "",
	open: false,
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export default {
	async fetch(req, env, ctx) {
		const url = new URL(req.url);
		const cors = corsHeaders(req, env);
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
		try {
			const res = await route(req, env, ctx, url);
			for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
			return res;
		} catch (e) {
			const res = json({ error: { message: e.expose ? e.message : "Something went wrong on the server." } }, e.status || 500);
			for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
			return res;
		}
	},
	// every few minutes: the scheduled tasks that are due run (see "tasks")
	async scheduled(event, env, ctx) {
		ctx.waitUntil(runDueTasks(env, ctx));
	},
};

async function route(req, env, ctx, url) {
	const p = url.pathname.replace(/\/+$/, "");
	const m = req.method;
	if (p === "/api/pricing" && m === "GET") return json({ ...publicConfig(await config(env)), reach: await reachOf(env), google: env.GOOGLE_CLIENT_ID || "" });
	if (p === "/api/signup" && m === "POST") return signup(req, env);
	if (p === "/api/login" && m === "POST") return login(req, env);
	if (p === "/api/auth/google" && m === "POST") return googleSignIn(req, env);
	if (p === "/api/webhooks/lemonsqueezy" && m === "POST") return lemonWebhook(req, env);
	if (p === "/api/media/models" && m === "GET") return json(wsOn(env) ? await wsCatalog(env) : { image: [], video: [], speech: [], music: [] });
	if (p.startsWith("/api/admin/")) return admin(req, env, p, m);
	// a shared chat: anyone with its link can read it
	let sh;
	if ((sh = p.match(/^\/api\/shares\/([a-f0-9]{24})$/)) && m === "GET") return shareGet(env, sh[1]);

	const user = await authUser(req, env);
	if (p === "/api/shares" && m === "POST") return shareMake(req, env, user);
	if (sh && m === "DELETE") return shareDel(env, user, sh[1]);
	if (p === "/api/skills" && m === "POST") return skillsAdd(req, env, user);
	if (p === "/api/skills" && m === "GET") return skillsGet(env, url);
	if (p === "/api/tasks" && m === "GET") return taskList(env, user);
	if (p === "/api/tasks" && m === "POST") return taskSave(req, env, user);
	if (p === "/api/tasks/seen" && m === "POST") return taskSeen(req, env, user);
	let tk;
	if ((tk = p.match(/^\/api\/tasks\/([a-f0-9]{24})$/)) && m === "DELETE") return taskDel(env, user, tk[1]);
	if ((tk = p.match(/^\/api\/tasks\/([a-f0-9]{24})\/run$/)) && m === "POST") return taskRunNow(env, ctx, user, tk[1]);
	if (p === "/api/logout" && m === "POST") {
		await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256hex(bearer(req))).run();
		return json({ ok: true });
	}
	if (p === "/api/me" && m === "GET") return json(await meOf(env, user));
	if (p === "/api/chat/completions" && m === "POST") return chat(req, env, ctx, user);
	if (p === "/api/videos" && m === "POST") return videoSubmit(req, env, user);
	let mt;
	if ((mt = p.match(/^\/api\/videos\/([\w-]{1,80})$/)) && m === "GET") return videoPoll(env, user, mt[1]);
	if ((mt = p.match(/^\/api\/videos\/([\w-]{1,80})\/content$/)) && m === "GET") return videoContent(env, user, mt[1], url);
	if (p === "/api/images" && m === "POST") return imageGen(req, env, user);
	if (p === "/api/audio/speech" && m === "POST") return speech(req, env, user);
	if (p === "/api/music" && m === "POST") return music(req, env, user);
	if (p === "/api/tools/docs" && m === "POST") return toolDocs(req, env);
	if (p === "/api/tools/fetch" && m === "POST") return toolFetch(req, env);
	if (p === "/api/tools/search" && m === "POST") return toolSearch(req, env, user);
	if (p === "/api/payments/qris" && m === "POST") return qrisPayment(req, env, user);
	throw fail(404, "Not found");
}

// ------------------------------------------------------------------ helpers

function fail(status, message) {
	const e = new Error(message);
	e.status = status;
	e.expose = true;
	return e;
}
function json(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function corsHeaders(req, env) {
	const origin = req.headers.get("Origin") || "";
	const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
	// the site, and the same page opened on this computer (from a file, which says "null", or a local server): sign-in is a
	// token the page holds, not a cookie, so where the page is opened from gives nobody else's account away
	const local = origin === "null" || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
	const ok = !allowed.length || allowed.includes(origin) || allowed.includes("*") || local;
	return {
		"Access-Control-Allow-Origin": ok ? origin || "*" : allowed[0],
		"Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type, X-Admin-Token, HTTP-Referer, X-Title",
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}
const now = () => Date.now();
function id() {
	return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64(bytes) {
	let s = "";
	for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
	return btoa(s);
}
function unb64(s) {
	return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function sha256hex(s) {
	const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameString(a, b) {
	a = String(a);
	b = String(b);
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	return diff === 0;
}
function bearer(req) {
	const h = req.headers.get("Authorization") || "";
	return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}
async function body(req) {
	try {
		return await req.json();
	} catch {
		throw fail(400, "That request wasn't valid JSON.");
	}
}

async function config(env) {
	const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'pricing'").first();
	let saved = {};
	try {
		saved = row ? JSON.parse(row.v) : {};
	} catch {}
	// 8192 was the old default answer length, saved by any admin page that was saved back then: it cut long answers off
	const maxTokens = !saved.maxTokens || saved.maxTokens === 8192 ? DEFAULT_CONFIG.maxTokens : saved.maxTokens;
	return { ...DEFAULT_CONFIG, ...saved, maxTokens, multipliers: { ...DEFAULT_CONFIG.multipliers, ...(saved.multipliers || {}) }, bands: { ...DEFAULT_CONFIG.bands, ...(saved.bands || {}) }, free: { ...DEFAULT_CONFIG.free, ...(saved.free || {}) } };
}
function publicConfig(c) {
	return { creditUsd: c.creditUsd, media: Number(c.multipliers.media) || 2, free: { credits: Number(c.free.credits) || 0, hours: Number(c.free.hours) || 24 }, packs: c.packs.map(({ lemonVariant, ...p }) => p), currencies: c.currencies, qris: c.qris, checkout: c.checkout, support: c.support, open: !!c.open };
}

// ------------------------------------------------------------------ accounts

async function hashPassword(password, env, saltB64) {
	const iter = Number(env.PBKDF2_ITER || 20000);
	const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
	const key = await crypto.subtle.importKey("raw", enc.encode(password + (env.PEPPER || "")), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
	return "pbkdf2$" + iter + "$" + b64(salt) + "$" + b64(bits);
}
async function checkPassword(password, stored, env) {
	const [, iter, salt] = String(stored).split("$");
	const again = await hashPassword(password, { ...env, PBKDF2_ITER: iter }, salt);
	return sameString(again, stored);
}
async function newSession(env, userId) {
	const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]);
	await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256hex(token), userId, now() + 30 * 86400e3).run();
	return token;
}
function cleanEmail(e) {
	const s = String(e || "").trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 200) throw fail(400, "That email address doesn't look right.");
	return s;
}
async function signup(req, env) {
	const b = await body(req);
	const email = cleanEmail(b.email);
	const password = String(b.password || "");
	if (password.length < 8) throw fail(400, "Use a password of at least 8 characters.");
	const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
	if (exists) throw fail(409, "There's already an account with that email. Sign in instead.");
	const user = { id: id(), email };
	const f = await firstFree(env, await config(env));
	await env.DB.prepare("INSERT INTO users (id, email, pass, balance_mc, free_mc, free_reset_at, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)").bind(user.id, email, await hashPassword(password, env), f.free_mc, f.free_reset_at, now()).run();
	const token = await newSession(env, user.id);
	return json({ token, me: await meOf(env, { ...user, balance_mc: 0, ...f }) });
}
async function login(req, env) {
	const b = await body(req);
	const email = cleanEmail(b.email);
	const u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
	// an account made with Google has no password to check (and its marker must never be read as hashing settings)
	if (u && !String(u.pass || "").startsWith("pbkdf2$")) throw fail(401, "This account signs in with Google: use the Google button.");
	if (!u || !(await checkPassword(String(b.password || ""), u.pass, env))) throw fail(401, "Wrong email or password.");
	const token = await newSession(env, u.id);
	return json({ token, me: await meOf(env, u) });
}

// ------------------------------------------------------------------ sign in with Google
// The site's Google button hands back an ID token Google signed. It's checked here against Google's published keys: the
// signature, that it was made for this site (GOOGLE_CLIENT_ID, from the Google Cloud console), that it's Google's and
// still fresh, and that Google has verified the email. The account is the one with that email: made on first sign-in
// (free credits and all), the same account as signing up with that email and a password.
let GKEYS = { at: 0, keys: [] };
async function googleKeys(fresh) {
	if (!fresh && Date.now() - GKEYS.at < 3600e3 && GKEYS.keys.length) return GKEYS.keys;
	const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
	const j = await r.json().catch(() => ({}));
	if (Array.isArray(j.keys) && j.keys.length) GKEYS = { at: Date.now(), keys: j.keys };
	return GKEYS.keys;
}
function fromB64url(s) {
	s = String(s).replace(/-/g, "+").replace(/_/g, "/");
	while (s.length % 4) s += "=";
	return unb64(s);
}
async function verifyGoogle(token, clientId) {
	const no = (why) => fail(401, why || "That Google sign-in didn't go through. Try again.");
	const parts = String(token || "").split(".");
	if (parts.length !== 3) throw no();
	let head, claims;
	try {
		head = JSON.parse(dec.decode(fromB64url(parts[0])));
		claims = JSON.parse(dec.decode(fromB64url(parts[1])));
	} catch {
		throw no();
	}
	if (head.alg !== "RS256" || !head.kid) throw no();
	// Google turns its keys over every few days: one it doesn't know yet means fetching them again
	let jwk = (await googleKeys()).find((k) => k.kid === head.kid);
	if (!jwk) jwk = (await googleKeys(true)).find((k) => k.kid === head.kid);
	if (!jwk) throw no();
	const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
	const good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(parts[2]), enc.encode(parts[0] + "." + parts[1]));
	if (!good) throw no();
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!aud.includes(clientId)) throw no("That Google sign-in was made for another site.");
	if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") throw no();
	if (!(Number(claims.exp) * 1000 > now() - 60e3)) throw no("That Google sign-in has expired. Try again.");
	if (!claims.email || !(claims.email_verified === true || claims.email_verified === "true")) throw no("Google hasn't verified that email address.");
	return claims;
}
async function googleSignIn(req, env) {
	if (!env.GOOGLE_CLIENT_ID) throw fail(503, "Google sign-in isn't set up on this server yet.");
	const b = await body(req);
	const g = await verifyGoogle(b.credential, env.GOOGLE_CLIENT_ID);
	const email = cleanEmail(g.email);
	let u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
	const made = !u;
	if (!u) {
		u = { id: id(), email, balance_mc: 0, ...(await firstFree(env, await config(env))) };
		try {
			await env.DB.prepare("INSERT INTO users (id, email, pass, balance_mc, free_mc, free_reset_at, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)").bind(u.id, email, "google$" + String(g.sub || ""), u.free_mc, u.free_reset_at, now()).run();
		} catch {
			// signed in twice at once: the other one made it
			u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
			if (!u) throw fail(500, "Couldn't make your account. Try again.");
		}
	}
	const token = await newSession(env, u.id);
	// the first name Google has, so the app can greet you by it (kept in your browser, not here)
	return json({ token, me: await meOf(env, u), made, name: String(g.given_name || g.name || "").slice(0, 40) });
}
async function authUser(req, env) {
	const token = bearer(req);
	if (!token) throw fail(401, "Sign in to use Andromeda credits.");
	const row = await env.DB.prepare("SELECT u.* , s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?").bind(await sha256hex(token)).first();
	if (!row || row.expires_at < now()) throw fail(401, "Your session ended. Sign in again.");
	return refill(env, row, await config(env));
}

// ------------------------------------------------------------------ free credits
// A bucket of free credits per person. The clock starts when the first one is spent; when it runs out the bucket is full
// again. Free credits are always spent before paid ones, and nobody is shown tokens or money, only credits.
//
// All of it together stays inside the owner's budget: free.dailyCap credits a day (UTC) are handed out, across every
// account. Past that, nobody's bucket fills until tomorrow and bought credits still work, so a crowd arriving at once
// (a post going viral) costs at most the day's cap, never the owner's savings.
const nextDay = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
async function grantFree(env, c, mc) {
	const cap = Math.round((Number(c.free.dailyCap) || 0) * 1000);
	if (!cap || mc <= 0) return mc;
	const day = new Date().toISOString().slice(0, 10);
	await env.DB.prepare("INSERT OR IGNORE INTO free_days (day, mc) VALUES (?, 0)").bind(day).run();
	const r = await env.DB.prepare("UPDATE free_days SET mc = mc + ? WHERE day = ? AND mc + ? <= ?").bind(mc, day, mc, cap).run();
	return r.meta && r.meta.changes ? mc : 0;
}
async function refill(env, user, c) {
	const full = Math.round((Number(c.free.credits) || 0) * 1000);
	const due = user.free_reset_at && now() >= user.free_reset_at;
	// a full bucket that's never been touched since the amount went up (or an account from before free credits)
	const topUp = !user.free_reset_at && (user.free_mc || 0) < full;
	if (!due && !topUp) {
		// an empty bucket that fills at midnight UTC is one the day's pool couldn't fill (a used one fills a day after use)
		if (!(user.free_mc > 0) && user.free_reset_at === nextDay()) user.free_capped = true;
		return user;
	}
	if (!(await grantFree(env, c, full - Math.max(0, user.free_mc || 0)))) {
		// today's free credits are all given out: this bucket fills tomorrow
		await env.DB.prepare("UPDATE users SET free_reset_at = ? WHERE id = ?").bind(nextDay(), user.id).run();
		user.free_reset_at = nextDay();
		user.free_capped = true;
		return user;
	}
	await env.DB.prepare("UPDATE users SET free_mc = ?, free_reset_at = 0 WHERE id = ? AND free_reset_at = ?").bind(full, user.id, user.free_reset_at || 0).run();
	user.free_mc = full;
	user.free_reset_at = 0;
	return user;
}
// a new account's first bucket, if today's budget still has room
async function firstFree(env, c) {
	const full = Math.round((Number(c.free.credits) || 0) * 1000);
	const got = await grantFree(env, c, full);
	return { free_mc: got, free_reset_at: got || !full ? 0 : nextDay() };
}
const spendable = (u) => Math.max(0, u.free_mc || 0) + Math.max(0, u.balance_mc || 0);
function outOfCredits(u, c) {
	const left = u.free_reset_at ? Math.max(0, u.free_reset_at - now()) : 0;
	const mins = Math.max(1, Math.ceil(left / 60e3)), h = Math.floor(mins / 60), m = mins % 60, when = h ? h + "h" + (m ? " " + m + "m" : "") : m + "m";
	if (u.free_capped && left) return fail(402, "Today's free credits have all been given out (everyone shares one daily pool). Yours come in " + when + ", or buy credits to keep going.");
	return fail(402, left && Number(c.free.credits) > 0
		? "You've used your free credits for now. " + c.free.credits + " more come back in " + when + ", or buy credits to keep going."
		: "You're out of credits. Buy credits to keep going.");
}
// Hold mc: free credits first, then paid. Null if there isn't enough. The free clock starts on the first free credit.
async function take(env, userId, mc, c) {
	for (let tries = 0; tries < 6; tries++) {
		const u = await env.DB.prepare("SELECT balance_mc, free_mc, free_reset_at FROM users WHERE id = ?").bind(userId).first();
		const fromFree = Math.min(Math.max(0, u.free_mc || 0), mc), fromPaid = mc - fromFree;
		if (fromPaid > Math.max(0, u.balance_mc)) return null;
		const resetAt = fromFree > 0 && !u.free_reset_at ? now() + (Number(c.free.hours) || 24) * 3600e3 : u.free_reset_at || 0;
		// only if nothing else spent them in between: a race simply goes round again
		const r = await env.DB.prepare("UPDATE users SET free_mc = free_mc - ?, balance_mc = balance_mc - ?, free_reset_at = ? WHERE id = ? AND free_mc >= ? AND balance_mc >= ?").bind(fromFree, fromPaid, resetAt, userId, fromFree, fromPaid).run();
		if (r.meta && r.meta.changes) return { fromFree, fromPaid };
	}
	return null;
}
// What wasn't used goes back where it came from: the free credits are counted as spent first.
function giveBack(env, userId, held, charged) {
	const usedFree = Math.min(held.fromFree, charged);
	return env.DB.prepare("UPDATE users SET free_mc = free_mc + ?, balance_mc = balance_mc + ? WHERE id = ?").bind(held.fromFree - usedFree, held.fromPaid - (charged - usedFree), userId);
}
async function meOf(env, user) {
	const c = await config(env);
	const fresh = await env.DB.prepare("SELECT balance_mc, free_mc, free_reset_at FROM users WHERE id = ?").bind(user.id).first();
	const u = fresh || user;
	const pays = await env.DB.prepare("SELECT id, method, pack, amount, currency, credits_mc, status, created_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 10").bind(user.id).all();
	return {
		id: user.id,
		email: user.email,
		credits: (Math.max(0, u.balance_mc || 0) + Math.max(0, u.free_mc || 0)) / 1000,
		paid: Math.max(0, u.balance_mc || 0) / 1000,
		free: { left: Math.max(0, u.free_mc || 0) / 1000, of: Number(c.free.credits) || 0, hours: Number(c.free.hours) || 24, backAt: u.free_reset_at || null },
		payments: (pays.results || []).map((x) => ({ ...x, credits: x.credits_mc / 1000 })),
	};
}

// ------------------------------------------------------------------ the AI proxy

let PRICES = { at: 0, map: new Map() };
async function prices(env) {
	if (Date.now() - PRICES.at < 3600e3 && PRICES.map.size) return PRICES.map;
	const r = await fetch(orBase(env) + "/models");
	const j = await r.json();
	const map = new Map();
	// per token; reading a cached prompt back and writing one, where the catalog says; and the most it writes at once
	const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
	for (const m of j.data || []) map.set(m.id, { pin: Number(m.pricing?.prompt || 0), pout: Number(m.pricing?.completion || 0), pcr: num(m.pricing?.input_cache_read), pcw: num(m.pricing?.input_cache_write), mo: num(m.top_provider?.max_completion_tokens) });
	if (map.size) PRICES = { at: Date.now(), map };
	return map;
}
const orBase = (env) => (env.OPENROUTER_BASE || "https://openrouter.ai/api/v1").replace(/\/$/, "");
function multiplier(price, c) {
	const perM = price.pout * 1e6;
	return perM < c.bands.cheapBelow ? c.multipliers.cheap : perM >= c.bands.topFrom ? c.multipliers.top : c.multipliers.mid;
}

// ------------------------------------------------------------------ the ways to a model
//
// A model can be reached more than one way; when one says no before answering (doesn't have the model, its balance is
// out, it's down) the next is asked, so a person only ever sees an answer or the last way's error.
//   1. Cloudflare AI Gateway's Unified Billing (CF_ACCOUNT_ID + CF_API_TOKEN, a token with Workers AI Read): OpenAI,
//      Anthropic, Google and xAI on one prepaid Cloudflare balance, at the labs' own prices (Cloudflare adds 5% when
//      credits are bought). Claude goes in Anthropic's own format there, so its prompt caching, thinking and web search
//      work as Anthropic documents them; OpenAI answers a live question with its own web search (the Responses API).
//   2. OpenRouter (OPENROUTER_KEY), for every model it lists, with each lab's own web search.
// Each model is asked to think as hard as it did when it scored best. The model list and prices always come from
// OpenRouter's public catalog (no key needed): the labs' list prices.
// the spelling of a model's name that worked on each way last time (Cloudflare's catalog and OpenRouter's can differ)
const NAMES = new Map();

// ------------------------------------------------------------------ gateways paid in rupiah (QRIS: OVO, GoPay, DANA...)
// Any OpenAI-compatible gateway (RouterKu, Anoman, ModelRouter, OneAPI...): GATEWAY_URL (its base, ending /v1) and
// GATEWAY_KEY; a second and a third as GATEWAY2_URL / GATEWAY2_KEY and GATEWAY3_... (the one with the top models first,
// a cheaper one for the rest). Each goes first, in that order, for every model it carries. Its list of models says
// which those are and what it calls them: Claude Opus 5.5 is "claude-opus-5-5" on one gateway; "opus-5" is Claude Opus 5
// on another (its list's display name says so, or the aliases do: GATEWAY_ALIASES, {"its-name": "lab/model"}).
// WaveSpeed (WAVESPEED_KEY) is one of those with its address known, and goes before them all: every lab's big models
// (Claude Opus 5.5 and Fable 5.1, GPT-6, Gemini 3.1 Pro, Grok) under the same names as here, at the labs' own prices,
// paid by card, PayPal or Alipay.
function gateways(env) {
	const out = [];
	if (env.WAVESPEED_KEY) out.push({ n: "ws", base: "https://llm.wavespeed.ai/v1", key: String(env.WAVESPEED_KEY).trim(), fee: Number(env.WAVESPEED_FEE) || 1, aliases: {} });
	for (const n of ["", "2", "3"]) {
		const url = env["GATEWAY" + n + "_URL"], key = env["GATEWAY" + n + "_KEY"];
		if (!url || !key) continue;
		let aliases = {};
		try { aliases = JSON.parse(env["GATEWAY" + n + "_ALIASES"] || "{}") || {}; } catch {}
		out.push({ n: n || "1", base: String(url).trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, ""), key: String(key).trim(), fee: Number(env["GATEWAY" + n + "_FEE"]) || 1, aliases });
	}
	return out;
}
// what a gateway's own short names are, when its list doesn't say (by its address)
const KNOWN_ALIASES = {
	routerku: {
		"opus-5": "anthropic/claude-opus-5", "sonnet-5": "anthropic/claude-sonnet-5", "haiku-45": "anthropic/claude-haiku-4.5", "fable-5": "anthropic/claude-fable-5",
		"gpt-6-astra": "openai/gpt-6-astra", "gpt-55": "openai/gpt-5.5", "gpt-55-codex": "openai/gpt-5.5-codex", sol: "openai/gpt-5.6-sol", "gpt-4o": "openai/gpt-4o",
		"gemini-31": "google/gemini-3.1-pro", "gemini-36": "google/gemini-3.6-flash", "grok-45": "x-ai/grok-4.5", "glm-53": "z-ai/glm-5.3", "kimi-k3": "moonshotai/kimi-k3",
	},
};
const GWS = new Map();
// a model's name with its maker and every mark taken off: "anthropic/claude-opus-5.5" → "claudeopus55"
const bareKey = (id) => String(id).toLowerCase().replace(/:.*$/, "").replace(/^.*\//, "").replace(/[^a-z0-9]/g, "");
async function gatewayCatalog(g) {
	let c = GWS.get(g.base) || { at: 0, ids: [], byKey: new Map(), failed: 0 };
	if (c.ids.length && Date.now() - c.at < 3600e3) return c;
	// asked again at most every five minutes if it didn't answer (each chat waits on this)
	if (!c.ids.length && c.failed && Date.now() - c.failed < 300e3) return c;
	try {
		const r = await fetch(g.base + "/models", { headers: { Authorization: "Bearer " + g.key }, signal: AbortSignal.timeout(8000) });
		const j = await r.json();
		const items = (Array.isArray(j) ? j : j.data || j.models || []).map((m) => (typeof m === "string" ? { id: m } : { id: m.id || m.name, name: m.display_name || m.name || m.title || "" })).filter((m) => m.id).map((m) => ({ id: String(m.id), name: String(m.name || "") }));
		if (!items.length) throw new Error("no models");
		const byKey = new Map();
		const put = (k, id) => { if (k && !byKey.has(k)) byKey.set(k, id); };
		// its own names, the plain one before a relayed one ("claude-fable-5" before "claude-fable-5-openrouter"); one it
		// only has relayed ("kimi-k2-6-openrouter") is still found by its own name; then what its list says each one is
		// ("Gemini 3.1 Pro" for "gemini-31")
		for (const m of items.slice().sort((a, b) => a.id.length - b.id.length)) put(bareKey(m.id), m.id);
		for (const m of items) put(bareKey(m.id.replace(/-(openrouter(-backup)?|or)$/i, "")), m.id);
		for (const m of items) if (m.name && m.name !== m.id) put(bareKey(m.name), m.id);
		c = { at: Date.now(), ids: items.map((m) => m.id), byKey, failed: 0 };
	} catch {
		c = { ...c, failed: Date.now() };
	}
	GWS.set(g.base, c);
	return c;
}
// what this gateway calls this model: an alias that says so; its own name or display name when its list has it; when
// the list couldn't be read, the usual spellings to try; nothing when its list doesn't have it
function gatewayNames(g, model) {
	const lab = model.split("/")[0], name = model.slice(lab.length + 1).replace(/:.*$/, "");
	const c = GWS.get(g.base) || { ids: [] };
	const known = Object.entries(KNOWN_ALIASES).find(([host]) => g.base.toLowerCase().includes(host));
	const aliases = { ...(known ? known[1] : {}), ...g.aliases };
	const k = bareKey(model);
	// (an alias's model with its preview or date tag left off still counts: "gemini-3.1-pro" for "gemini-3.1-pro-preview")
	const mine = Object.entries(aliases).filter(([gid, target]) => {
		const t = bareKey(target);
		return provider(target) === lab && (k === t || (k.startsWith(t) && /^(preview|latest|\d{4,8})+$/.test(k.slice(t.length)))) && (!c.ids.length || c.ids.includes(gid));
	}).map(([gid]) => gid);
	if (mine.length) return mine;
	if (c.ids.length) {
		// "claude-sonnet-5" may be "sonnet-5" there: the family word left off
		const hit = c.byKey.get(k) || c.byKey.get(k.replace(/^(claude|gpt|gemini|grok)/, ""));
		return hit ? [hit] : [];
	}
	return [...new Set([model, name, name.replace(/(\d)\.(\d)/g, "$1-$2")])];
}
const provider = (id) => String(id).split("/")[0];

function routes(env, model, web, tools) {
	const out = [];
	const lab = model.split("/")[0], name = model.slice(lab.length + 1).replace(/:.*$/, "");
	for (const g of gateways(env)) {
		const names = gatewayNames(g, model);
		if (names.length) out.push({ kind: "gw", gw: g.n, lab, url: g.base + "/chat/completions", headers: { Authorization: "Bearer " + g.key }, names, fee: g.fee, native: false });
	}
	if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN && ["openai", "anthropic", "google", "x-ai"].includes(lab)) {
		const base = "https://api.cloudflare.com/client/v4/accounts/" + env.CF_ACCOUNT_ID + "/ai/v1/";
		const headers = { Authorization: "Bearer " + env.CF_API_TOKEN, ...(env.CF_GATEWAY ? { "cf-aig-gateway-id": env.CF_GATEWAY } : {}) };
		// Anthropic writes a version with a dash (claude-opus-5-5), OpenRouter with a dot (claude-opus-5.5)
		const names = lab === "anthropic" ? [...new Set(["anthropic/" + name.replace(/(\d)\.(\d)/g, "$1-$2"), "anthropic/" + name])] : [(lab === "x-ai" ? "xai" : lab) + "/" + name];
		if (lab === "anthropic") out.push({ kind: "claude", lab, url: base + "messages", headers, names, fee: 1.05, native: true });
		if (lab === "openai" && web && !tools) out.push({ kind: "responses", lab, url: base + "responses", headers, names, fee: 1.05, native: true });
		out.push({ kind: "gateway", lab, url: base + "chat/completions", headers, names, fee: 1.05, native: false });
	}
	if (env.OPENROUTER_KEY) out.push({ kind: "openrouter", lab, url: orBase(env) + "/chat/completions", headers: { Authorization: "Bearer " + env.OPENROUTER_KEY, "HTTP-Referer": env.SITE_URL || "https://andromeda.app", "X-Title": "Andromeda" }, names: [model], fee: 1, native: true });
	// a live question goes first to a way where the model searches the web itself, the way its search was rated
	return web ? [...out.filter((w) => w.native), ...out.filter((w) => !w.native)] : out;
}
// Is there money on the OpenRouter account? (an empty one turns every request away: "can only afford 0 tokens"). Asked
// every ten minutes; if OpenRouter doesn't say, it's taken as yes
let ORFUND = { at: 0, ok: true };
async function orFunded(env) {
	if (!env.OPENROUTER_KEY) return false;
	if (Date.now() - ORFUND.at < 600e3) return ORFUND.ok;
	let ok = true;
	try {
		const r = await fetch(orBase(env) + "/credits", { headers: { Authorization: "Bearer " + env.OPENROUTER_KEY }, signal: AbortSignal.timeout(6000) });
		if (r.ok) {
			const d = (await r.json()).data || {};
			if (d.total_credits != null) ok = Number(d.total_credits) - Number(d.total_usage || 0) > 0.25;
		}
	} catch {}
	ORFUND = { at: Date.now(), ok };
	return ok;
}
// What this server can answer with, so the site only routes to models that will answer: everything through a funded
// OpenRouter; the four labs Cloudflare bills (only what the labs serve themselves: OpenAI's open-weight, -pro and
// Codex models aren't on its chat endpoint); and every model the gateway lists, by exact name
async function reachOf(env) {
	const cf = !!(env.CF_ACCOUNT_ID && env.CF_API_TOKEN), gws = gateways(env);
	const or = !!env.OPENROUTER_KEY && (!(gws.length || cf) || (await orFunded(env)));
	// where the studio's models come from: this server (WaveSpeed) or OpenRouter's own list
	const mediaFrom = wsOn(env) ? "server" : env.OPENROUTER_KEY ? "openrouter" : "";
	if (or) return { all: true, only: "", skip: "", media: true, mediaFrom };
	const out = { all: false, only: cf ? "^(openai|anthropic|google|x-ai)/" : "^$", skip: "^openai/(gpt-oss|.*-pro$|.*codex|.*deep-research)|:", media: !!mediaFrom, mediaFrom };
	if (gws.length) {
		const cats = await Promise.all(gws.map(gatewayCatalog));
		if (cats.some((c) => c.ids.length)) {
			const ids = [...(await prices(env)).keys()].filter((id) => !/:/.test(id));
			out.models = ids.filter((id) => gws.some((g, i) => cats[i].ids.length && gatewayNames(g, id).length));
		} else out.all = true; // no list could be read: every model is tried, the names a gateway doesn't know fall through
	}
	return out;
}
function errorText(t, fallback) {
	try {
		let j = JSON.parse(t);
		if (Array.isArray(j)) j = j[0];
		const m = j?.error?.message || j?.errors?.[0]?.message || j?.message;
		if (m) return String(m).slice(0, 500);
	} catch {}
	return String(fallback || "The AI provider said no.").slice(0, 300);
}

// The request as an OpenAI-format way takes it. OpenRouter takes it as the site sent it, with each lab's own web search
// at its most thorough when the site asks for a search. Cloudflare's chat endpoint gets plain OpenAI chat: no OpenRouter
// fields, no caching marks (only Claude reads them, and Claude goes the Anthropic way), the thinking level as
// reasoning_effort, max_completion_tokens for OpenAI (its reasoning models refuse max_tokens, and temperature), and the
// usage asked for at the end of a stream
const KEEP = ["stream", "temperature", "top_p", "stop", "tools", "tool_choice", "parallel_tool_calls", "response_format", "seed", "n", "presence_penalty", "frequency_penalty"];
function openaiBody(b, way, name, maxOut, userId, web) {
	if (way.kind === "openrouter") {
		const out = { ...b, model: name, max_tokens: maxOut, usage: { include: true }, user: userId };
		if (web) {
			out.plugins = [{ id: "web", max_results: web.n }];
			out.web_search_options = { search_context_size: "high" };
		}
		return out;
	}
	const out = { model: name };
	for (const k of KEEP) if (b[k] !== undefined) out[k] = b[k];
	out.messages = (b.messages || []).map((m) => {
		const x = { role: m.role, content: Array.isArray(m.content) ? m.content.map(({ cache_control, ...p }) => p) : m.content == null ? "" : m.content };
		for (const k of ["name", "tool_calls", "tool_call_id"]) if (m[k] !== undefined) x[k] = m[k];
		return x;
	});
	const effort = b.reasoning && b.reasoning.effort;
	// OpenAI's reasoning models take the length as max_completion_tokens; a way that wants it the other way round said so
	if ((way.lab === "openai") !== !!way.swapMax) {
		out.max_completion_tokens = maxOut;
		if (way.lab === "openai") {
			delete out.temperature;
			delete out.top_p;
		}
	} else out.max_tokens = maxOut;
	if (effort) out.reasoning_effort = effort;
	if (b.stream) out.stream_options = { include_usage: true };
	return out;
}

// ------------------------------------------------------------------ Claude in Anthropic's own format
//
// What the site sends in OpenAI's format, turned into Anthropic's Messages API and back, so the caching marks on the
// system prompt and the conversation so far reach Claude (a prompt read back from the cache costs a tenth), Claude
// searches the web itself when the site asks for a search (its sources listed after the answer), and thinking is asked
// for the way each model takes it: Claude 4.6 and later think adaptively at an effort level ("enabled" with a token
// budget is refused from 4.7 on); 3.7 to 4.5 take a budget, and only without the site's tools, since a tool loop would
// have to send every thinking block back
const STOP = { end_turn: "stop", stop_sequence: "stop", max_tokens: "length", tool_use: "tool_calls", refusal: "content_filter", pause_turn: "stop" };
function claudeBody(b, name, maxOut, web) {
	const blocks = (content) => {
		if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
		const out = [];
		for (const p of content || []) {
			if (p.type === "text") {
				if (p.text) out.push({ type: "text", text: p.text, ...(p.cache_control ? { cache_control: p.cache_control } : {}) });
			} else if (p.type === "image_url") {
				const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url || "";
				const m = url.match(/^data:([^;,]+);base64,([\s\S]*)$/);
				out.push(m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : { type: "image", source: { type: "url", url } });
			} else if (p.type === "file" && p.file?.file_data) {
				const m = String(p.file.file_data).match(/^data:(application\/pdf);base64,([\s\S]*)$/);
				if (m) out.push({ type: "document", source: { type: "base64", media_type: m[1], data: m[2] } });
			}
		}
		return out;
	};
	const system = [], messages = [];
	// Anthropic wants the turns to alternate: two in a row from one side become one turn
	const add = (role, content) => {
		if (!content.length) return;
		const last = messages[messages.length - 1];
		if (last && last.role === role) last.content.push(...content);
		else messages.push({ role, content });
	};
	for (const m of b.messages || []) {
		if (m.role === "system" || m.role === "developer") system.push(...blocks(m.content));
		else if (m.role === "tool") {
			const parts = blocks(m.content);
			const mark = parts.find((p) => p.cache_control)?.cache_control;
			const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
			add("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: text || "(empty)", ...(mark ? { cache_control: mark } : {}) }]);
		} else if (m.role === "assistant") {
			const parts = blocks(m.content).filter((p) => p.type === "text");
			for (const call of m.tool_calls || []) {
				let input = {};
				try { input = typeof call.function?.arguments === "string" ? JSON.parse(call.function.arguments || "{}") : call.function?.arguments || {}; } catch {}
				parts.push({ type: "tool_use", id: call.id, name: call.function?.name, input });
			}
			add("assistant", parts);
		} else add("user", blocks(m.content));
	}
	if (messages[0] && messages[0].role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "(continuing)" }] });
	const out = { model: name, max_tokens: maxOut, messages };
	if (b.stream) out.stream = true;
	if (system.length) out.system = system;
	if (b.temperature != null) out.temperature = b.temperature;
	if (b.top_p != null) out.top_p = b.top_p;
	if (b.stop) out.stop_sequences = [].concat(b.stop);
	const own = Array.isArray(b.tools) && b.tools.length;
	if (own) {
		out.tools = b.tools.filter((t) => t && t.type === "function" && t.function).map((t) => ({ name: t.function.name, description: t.function.description || "", input_schema: t.function.parameters || { type: "object", properties: {} } }));
		const tc = b.tool_choice;
		if (tc === "required") out.tool_choice = { type: "any" };
		else if (tc === "none") out.tool_choice = { type: "none" };
		else if (tc && tc.function && tc.function.name) out.tool_choice = { type: "tool", name: tc.function.name };
	}
	if (web) out.tools = [...(out.tools || []), { type: "web_search_20250305", name: "web_search", max_uses: Math.max(3, web.n) }];
	const effort = b.reasoning && b.reasoning.effort;
	const v = Number((String(b.model).match(/(\d+(?:\.\d+)?)/) || [])[1]) || 0;
	if (effort && v >= 4.6) {
		out.thinking = { type: "adaptive" };
		out.output_config = { effort: effort === "minimal" ? "low" : effort };
	} else if (effort && v >= 3.7 && !own && maxOut >= 2048) {
		out.thinking = { type: "enabled", budget_tokens: Math.max(1024, Math.min(maxOut - 1024, Math.round(maxOut * ({ minimal: 0.1, low: 0.2, medium: 0.5, high: 0.8, xhigh: 0.95, max: 0.95 }[effort] || 0.5)))) };
	}
	// thinking takes only the default sampling, and the newest models think whether asked or not
	if (out.thinking || v >= 5) {
		delete out.temperature;
		delete out.top_p;
	}
	return out;
}
function claudeUsage(u) {
	u = u || {};
	const read = u.cache_read_input_tokens || 0, wrote = u.cache_creation_input_tokens || 0, fresh = u.input_tokens || 0, out = u.output_tokens || 0;
	return { prompt_tokens: fresh + read + wrote, completion_tokens: out, total_tokens: fresh + read + wrote + out, prompt_tokens_details: { cached_tokens: read, cache_write_tokens: wrote }, web_searches: u.server_tool_use?.web_search_requests || 0 };
}
// the pages a searched answer drew on, after it
function sourcesText(sources) {
	if (!sources.size) return "";
	return "\n\n**Sources:** " + [...sources].map(([url, title], i) => "[" + (i + 1) + ". " + String(title || url).replace(/[[\]]/g, "").slice(0, 80) + "](" + url + ")").join(" · ");
}
function fromClaude(j, model) {
	let text = "", reasoning = "";
	const calls = [], sources = new Map();
	for (const blk of j.content || []) {
		if (blk.type === "text") {
			text += blk.text;
			for (const c of blk.citations || []) if (c.url && !sources.has(c.url)) sources.set(c.url, c.title);
		} else if (blk.type === "thinking") reasoning += blk.thinking || "";
		else if (blk.type === "tool_use") calls.push({ id: blk.id, type: "function", function: { name: blk.name, arguments: JSON.stringify(blk.input || {}) } });
	}
	const message = { role: "assistant", content: text + sourcesText(sources) };
	if (calls.length) message.tool_calls = calls;
	if (reasoning) message.reasoning = reasoning;
	return { id: j.id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: STOP[j.stop_reason] || "stop" }], usage: claudeUsage(j.usage) };
}
// Anthropic's stream events, as OpenAI's stream chunks
function claudeStream(model) {
	const created = Math.floor(Date.now() / 1000);
	const tools = new Map(), sources = new Map();
	let id = "msg", u = {};
	const chunk = (delta, finish = null) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
	const s = { finished: false, usage: () => claudeUsage(u) };
	s.feed = (e) => {
		switch (e.type) {
			case "message_start":
				id = e.message?.id || id;
				u = { ...(e.message?.usage || {}) };
				return [chunk({ role: "assistant", content: "" })];
			case "content_block_start": {
				const cb = e.content_block || {};
				if (cb.type === "tool_use") {
					tools.set(e.index, tools.size);
					return [chunk({ tool_calls: [{ index: tools.get(e.index), id: cb.id, type: "function", function: { name: cb.name, arguments: "" } }] })];
				}
				return cb.type === "text" && cb.text ? [chunk({ content: cb.text })] : [];
			}
			case "content_block_delta": {
				const d = e.delta || {};
				if (d.type === "text_delta") return [chunk({ content: d.text })];
				if (d.type === "thinking_delta") return [chunk({ reasoning: d.thinking })];
				if (d.type === "citations_delta" && d.citation?.url && !sources.has(d.citation.url)) sources.set(d.citation.url, d.citation.title);
				if (d.type === "input_json_delta" && tools.has(e.index)) return [chunk({ tool_calls: [{ index: tools.get(e.index), function: { arguments: d.partial_json } }] })];
				return [];
			}
			case "message_delta": {
				Object.assign(u, e.usage || {});
				const extra = sourcesText(sources);
				sources.clear();
				return [...(extra ? [chunk({ content: extra })] : []), chunk({}, STOP[e.delta?.stop_reason] || "stop")];
			}
			case "message_stop":
				s.finished = true;
				return [];
			case "error":
				return [{ error: { message: e.error?.message || "The model stopped with an error." } }];
			default:
				return [];
		}
	};
	return s;
}

// ------------------------------------------------------------------ OpenAI's Responses API, for its own web search
//
// GPT searches the web itself only through the Responses API: a live question to a GPT model goes there, in and out of
// the chat format the site speaks
function responsesBody(b, name, maxOut) {
	const input = [];
	for (const m of b.messages || []) {
		if (!["system", "developer", "user", "assistant"].includes(m.role)) continue;
		const mine = m.role === "assistant";
		const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
		const content = parts.map((p) => (p.type === "text" ? (p.text ? { type: mine ? "output_text" : "input_text", text: p.text } : null)
			: p.type === "image_url" && !mine ? { type: "input_image", image_url: typeof p.image_url === "string" ? p.image_url : p.image_url?.url } : null)).filter(Boolean);
		if (content.length) input.push({ role: m.role, content });
	}
	const out = { model: name, input, max_output_tokens: maxOut, tools: [{ type: "web_search" }] };
	if (b.stream) out.stream = true;
	if (b.reasoning && b.reasoning.effort) out.reasoning = { effort: b.reasoning.effort };
	return out;
}
function responsesUsage(u, searches) {
	u = u || {};
	return { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: u.total_tokens || (u.input_tokens || 0) + (u.output_tokens || 0), prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens || 0 }, web_searches: searches };
}
function fromResponses(j, model) {
	let text = "";
	const sources = new Map();
	let searches = 0;
	for (const item of j.output || []) {
		if (item.type === "web_search_call") searches++;
		if (item.type !== "message") continue;
		for (const c of item.content || []) {
			if (c.type !== "output_text") continue;
			text += c.text || "";
			for (const a of c.annotations || []) if (a.type === "url_citation" && a.url && !text.includes(a.url) && !sources.has(a.url)) sources.set(a.url, a.title);
		}
	}
	const finish = j.status === "incomplete" ? "length" : "stop";
	return { id: j.id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: text + sourcesText(sources) }, finish_reason: finish }], usage: responsesUsage(j.usage, searches) };
}
// the Responses API's stream events, as OpenAI's chat stream chunks
function responsesStream(model) {
	const created = Math.floor(Date.now() / 1000);
	const sources = new Map();
	let u = null, searches = 0, text = "";
	const chunk = (delta, finish = null) => ({ id: "resp", object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
	const s = { finished: false, usage: () => responsesUsage(u, searches) };
	s.feed = (e) => {
		switch (e.type) {
			case "response.output_text.delta":
				text += e.delta || "";
				return e.delta ? [chunk({ content: e.delta })] : [];
			case "response.reasoning_summary_text.delta":
				return e.delta ? [chunk({ reasoning: e.delta })] : [];
			case "response.output_text.annotation.added": {
				const a = e.annotation || {};
				if (a.type === "url_citation" && a.url && !sources.has(a.url)) sources.set(a.url, a.title);
				return [];
			}
			case "response.web_search_call.completed":
				searches++;
				return [];
			case "response.completed":
			case "response.incomplete": {
				u = e.response?.usage || u;
				s.finished = true;
				// the sources it cited that its text doesn't already link to
				for (const url of [...sources.keys()]) if (text.includes(url)) sources.delete(url);
				const extra = sourcesText(sources);
				return [...(extra ? [chunk({ content: extra })] : []), chunk({}, e.type === "response.incomplete" ? "length" : "stop")];
			}
			case "response.failed":
				s.finished = true;
				return [{ error: { message: e.response?.error?.message || "The model stopped with an error." } }];
			case "error":
				return [{ error: { message: e.message || e.error?.message || "The model stopped with an error." } }];
			default:
				return [];
		}
	};
	return s;
}

// What this much use costs. list: at the labs' list prices, what a person's credits are worked out from, the same
// whichever way it went. real: what the owner pays for it that way (the list price plus Cloudflare's 5% there,
// OpenRouter's own figure there). A prompt read back from a cache is billed at the cached price; a lab's own web search
// at about a cent a search.
function priceOf(way, u, price, inTokens, outChars) {
	u = u || {};
	const own = Number(u.cost);
	if (way.kind === "openrouter" && u.cost != null && Number.isFinite(own)) return { list: own, real: own };
	const prompt = u.prompt_tokens || inTokens;
	const read = Math.min(prompt, u.prompt_tokens_details?.cached_tokens || 0);
	const wrote = Math.min(prompt - read, u.prompt_tokens_details?.cache_write_tokens || 0);
	// Gemini leaves its thinking out of completion_tokens but bills it: it's in the total
	const out = Math.max(u.completion_tokens || 0, (u.total_tokens || 0) - (u.prompt_tokens || 0)) || Math.ceil((outChars || 0) / 4);
	const claude = way.lab === "anthropic";
	const list = (prompt - read - wrote) * price.pin + read * (price.pcr ?? (claude ? price.pin * 0.1 : price.pin)) + wrote * (price.pcw ?? (claude ? price.pin * 1.25 : price.pin)) + out * price.pout + (u.web_searches || 0) * 0.01;
	return { list, real: list * (way.fee || 1) };
}

// Live web search the server runs itself, for a model reached a way where it can't search on its own (Gemini and Grok
// through Cloudflare): Tavily (TAVILY_KEY: 1,000 free searches a month, no card needed) or Brave (BRAVE_KEY). Nothing
// if neither is set or they fail
async function searchWeb(env, q, n) {
	q = String(q || "").replace(/\s+/g, " ").trim().slice(0, 300);
	if (!q) return [];
	const clean = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
	try {
		if (env.TAVILY_KEY) {
			const r = await fetch("https://api.tavily.com/search", { method: "POST", headers: { Authorization: "Bearer " + env.TAVILY_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ query: q, max_results: n, search_depth: "advanced" }), signal: AbortSignal.timeout(15000) });
			if (r.ok) {
				const found = ((await r.json()).results || []).slice(0, n).map((x) => ({ title: clean(x.title), url: x.url, text: clean(x.content).slice(0, 1500) }));
				if (found.length) return found;
			}
		}
		if (env.BRAVE_KEY) {
			const r = await fetch("https://api.search.brave.com/res/v1/web/search?count=" + n + "&q=" + encodeURIComponent(q), { headers: { "X-Subscription-Token": env.BRAVE_KEY, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
			if (r.ok) return ((await r.json()).web?.results || []).slice(0, n).map((x) => ({ title: clean(x.title), url: x.url, text: clean([x.description, ...(x.extra_snippets || [])].join(" ")).slice(0, 1500) }));
		}
	} catch {}
	return [];
}
// No search key: a model that searches the web for itself finds the sources (WaveSpeed's models with web search, or
// OpenRouter's web plugin), so search works from the start. Only what it actually cites is kept (a model that answered
// from memory isn't searching, and its links aren't trusted). About a cent a search, charged like anything else.
const SEARCHERS = ["x-ai/grok-4.7", "openai/gpt-5.4-nano", "google/gemini-3.5-flash-lite", "anthropic/claude-haiku-5.5", "openai/gpt-4o-mini"];
const SEARCH_OFF = new Map(); // a gateway that answered without searching: not asked again for an hour
async function modelSearch(env, q, n) {
	const ways = [...gateways(env).filter((g) => g.n === "ws").map((g) => ({ id: "ws", base: g.base, key: g.key })), ...(env.OPENROUTER_KEY ? [{ id: "or", base: orBase(env), key: env.OPENROUTER_KEY }] : [])];
	const ask = "Search the web now for: " + q + "\n\nThen reply with ONLY JSON: {\"results\": [{\"title\": \"...\", \"url\": \"the page's address\", \"text\": \"what that page says that matters here, in 2 to 4 sentences, with its date if it has one\"}]}: up to " + n + " results from different sources, the most useful and recent first.";
	let usd = 0;
	for (const w of ways) {
		if (Date.now() - (SEARCH_OFF.get(w.id) || 0) < 3600e3) continue;
		models: for (const model of SEARCHERS) {
			for (const extra of [{ plugins: [{ id: "web", max_results: n }], web_search_options: { search_context_size: "medium" } }, { web_search_options: { search_context_size: "medium" } }]) {
				let r;
				try {
					r = await fetch(w.base + "/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + w.key, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: ask }], max_tokens: 2000, temperature: 0, ...extra }), signal: AbortSignal.timeout(40000) });
				} catch { continue models; }
				// a model it doesn't have: the next one; settings it doesn't take: the plainer form
				if (r.status === 400 || r.status === 422) continue;
				if (!r.ok) continue models;
				const j = await r.json().catch(() => null);
				usd += Number(j?.usage?.cost) || 0.012;
				const msg = j?.choices?.[0]?.message || {};
				const cites = (msg.annotations || []).map((a) => a.url_citation || a).filter((c) => c && /^https?:\/\//.test(String(c.url || "")));
				if (!cites.length) { SEARCH_OFF.set(w.id, Date.now()); break models; }
				let said = [];
				try { said = JSON.parse(String(msg.content || "").replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, "$1")).results || []; } catch {}
				const seen = new Set(), out = [];
				for (const c of cites) {
					const u = String(c.url).replace(/[?&]utm_[^&]+/g, "");
					if (seen.has(u)) continue;
					seen.add(u);
					const s = said.find((x) => x && String(x.url || "").replace(/\/$/, "") === u.replace(/\/$/, ""));
					out.push({ title: String(c.title || (s && s.title) || new URL(u).hostname).slice(0, 200), url: u, text: String((s && s.text) || c.content || "").slice(0, 1500) });
				}
				return { results: out.slice(0, n), usd, model };
			}
		}
	}
	return { results: [], usd };
}
// what a search finds: the search key's results, or (with none) a model's own search, held and charged to the person
async function searchFor(env, user, q, n) {
	const keyed = await searchWeb(env, q, n);
	if (keyed.length || !user) return keyed;
	const c = await config(env), mt = media(c);
	const held = await take(env, user.id, mt.toMc(0.06), c);
	if (!held) return [];
	let got = { results: [], usd: 0 };
	try { got = await modelSearch(env, q, n); }
	finally { await charge(env, user.id, "web-search" + (got.model ? ": " + got.model : ""), held, got.usd, mt); }
	return got.results;
}
// the search results go in front of the newest message (not the system prompt), so the cached start of the
// conversation stays the same
function withNote(messages, note) {
	const out = (messages || []).slice();
	for (let i = out.length - 1; i >= 0; i--) {
		if (out[i].role !== "user") continue;
		const m = out[i];
		out[i] = { ...m, content: typeof m.content === "string" ? note + m.content : [{ type: "text", text: note }, ...(m.content || [])] };
		return out;
	}
	return out;
}
function lastUserText(messages) {
	for (let i = (messages || []).length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		return typeof m.content === "string" ? m.content : (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join(" ");
	}
	return "";
}

// room for thinking on top of the answer, by how hard a model is asked to think (it's billed as output, and only what's
// used is charged): the thinking a model scored best with is only there if it has room for it
const THINK_ROOM = { none: 0, minimal: 2048, low: 8192, medium: 16384, high: 32768, xhigh: 65536, max: 98304 };

async function chat(req, env, ctx, user) {
	const c = await config(env);
	const b = await body(req);
	if (typeof b.model !== "string" || b.model.startsWith("openrouter/")) throw fail(400, "Pick a specific model.");
	const price = (await prices(env)).get(b.model);
	if (!price) throw fail(400, "That model isn't available.");
	if (spendable(user) < 1000) throw outOfCredits(user, c);
	// a live web search, when the site asks for one: the model's own search where the way allows it (how the search
	// leaderboard rates them), otherwise the server's own search results as numbered sources
	const plug = (Array.isArray(b.plugins) ? b.plugins : []).find((x) => x && x.id === "web");
	delete b.plugins;
	const web = plug ? { n: Math.max(1, Math.min(8, Number(plug.max_results) || 5)), query: plug.query || lastUserText(b.messages) } : null;
	await Promise.all(gateways(env).map(gatewayCatalog));
	const ways = routes(env, b.model, !!web, Array.isArray(b.tools) && b.tools.length > 0);
	if (!ways.length) throw fail(503, "This server can't reach that model. Pick another, or try again later.");

	const mult = multiplier(price, c);
	// credits -> what the request may spend at list prices
	const toUsd = (mc) => (mc / 1000) * c.creditUsd / mult;
	// a hair under, so floating-point dust (1.0000000000000002) never rounds a whole extra unit up
	const toMc = (usd) => Math.ceil((usd * mult / c.creditUsd) * 1000 - 1e-6);
	const inTokens = Math.ceil((JSON.stringify(b.messages || []).length + (b.tools ? JSON.stringify(b.tools).length : 0)) / 3);
	// a search is held at its worst case too: a few searches, and what they read
	const inUsd = inTokens * price.pin + (web ? web.n * 0.01 + 20000 * price.pin : 0);
	const room = toUsd(spendable(user)) - inUsd;
	if (room <= 0) throw fail(402, "Not enough credits for a message this long. Buy credits or start a new chat.");
	const effort = b.reasoning && b.reasoning.effort;
	const thinkRoom = THINK_ROOM[effort] || 0;
	let maxOut = Math.min((Number(b.max_tokens) || c.maxTokens) + thinkRoom, c.maxTokens + thinkRoom);
	if (price.mo > 0) maxOut = Math.min(maxOut, price.mo);
	if (price.pout > 0) maxOut = Math.min(maxOut, Math.floor(room / price.pout));
	if (maxOut < 64) throw fail(402, "Not enough credits for this model. Buy credits or choose a lower Quality.");

	// reserve the worst case first; only one statement can win, so parallel requests can't overspend
	const reserve = toMc(inUsd + maxOut * price.pout);
	const held = await take(env, user.id, reserve, c);
	if (!held) throw outOfCredits(user, c);

	let settled = false;
	const settle = async (way, usage, outChars) => {
		if (settled) return null;
		settled = true;
		const { list, real } = way ? priceOf(way, usage, price, inTokens, outChars) : { list: 0, real: 0 };
		// the real cost, even past the reserve (the input estimate can run low, e.g. images): the owner never absorbs it.
		// The output was capped to what the balance covers, so any overshoot is small, and a balance below zero only
		// blocks the next request until credits are bought.
		const charged = toMc(list);
		await env.DB.batch([
			giveBack(env, user.id, held, charged),
			env.DB.prepare("INSERT INTO usage (user_id, model, cost_usd, charged_mc, created_at) VALUES (?, ?, ?, ?, ?)").bind(user.id, b.model, real, charged, now()),
		]);
		return charged;
	};

	// the server's own search results, fetched once, only if a way that can't search for itself is asked
	let noted = null;
	const notedMessages = async () => {
		if (noted) return noted;
		const found = await searchFor(env, user, web.query, web.n);
		noted = withNote(b.messages, found.length
			? "Live web search results for this, just fetched. Use them for anything current and cite them inline as [n](url):\n\n" + found.map((x, i) => "[" + (i + 1) + "] " + x.title + " (" + x.url + ")\n" + x.text).join("\n\n") + "\n\n---\n\n"
			: "(A live web search wasn't possible just now: answer from what you know, and say plainly if it may be out of date.)\n\n");
		return noted;
	};
	const build = async (w, name, plain) => {
		const req = plain ? { ...b, reasoning: undefined } : b;
		if (w.kind === "claude") return claudeBody(req, name, maxOut, web);
		if (w.kind === "responses") return responsesBody(req, name, maxOut);
		if ((w.kind === "gateway" || w.kind === "gw") && web) return openaiBody({ ...req, messages: await notedMessages() }, w, name, maxOut, user.id, null);
		return openaiBody(req, w, name, maxOut, user.id, web);
	};

	let r = null, way = null, last = null;
	ask: for (const w of ways) {
		// (each gateway remembers its own spelling)
		const known = NAMES.get(w.kind + (w.gw || "") + " " + b.model);
		const names = known ? [known, ...w.names.filter((n) => n !== known)] : w.names;
		for (let k = 0; k < names.length; k++) {
			// a thinking level a lab won't take this way is asked again once without it, before the next way is tried
			for (const plain of effort && w.kind !== "openrouter" ? [false, true] : [false]) {
				let res;
				// asked again (twice at most) when the way can pay for a shorter answer than the longest one allowed, or
				// wants the answer's length given the other way (max_tokens / max_completion_tokens)
				for (let again = 0; again < 3; again++) {
					try {
						res = await fetch(w.url, { method: "POST", headers: { ...w.headers, "Content-Type": "application/json" }, body: JSON.stringify(await build(w, names[k], plain)) });
					} catch {
						last = { status: 502, message: "Couldn't reach the AI provider. Try again." };
						continue ask;
					}
					if (res.ok) {
						r = res;
						way = w;
						NAMES.set(w.kind + (w.gw || "") + " " + b.model, names[k]);
						break ask;
					}
					const t = await res.text().catch(() => "");
					last = { status: res.status, message: errorText(t, res.statusText) };
					// "You requested up to 65536 tokens, but can only afford 3320": an everyday answer fits in what it can afford
					const afford = Number((/can only afford (\d+)/i.exec(last.message) || [])[1]);
					if (res.status === 402 && afford >= 256 && afford < maxOut) {
						maxOut = Math.floor(afford * 0.95);
						continue;
					}
					if (res.status === 400 && !w.swapMax && w.kind !== "openrouter" && /max_(completion_)?tokens/i.test(last.message) && /support|instead|unrecogni[sz]ed|unknown|not allowed|invalid/i.test(last.message)) {
						w.swapMax = true;
						continue;
					}
					break;
				}
				const bad = res.status === 400 || res.status === 404;
				if (bad && !plain && effort && /effort|reasoning|thinking/i.test(last.message)) continue;
				// a spelling of the name it doesn't know: the next spelling; anything else: the next way
				if (bad && /model/i.test(last.message)) break;
				continue ask;
			}
		}
	}
	if (!r) {
		await settle(null);
		// the owner's provider account refusing (no balance, a bad key) isn't the person's credits running out
		const status = !last ? 502 : [401, 402, 403].includes(last.status) ? 503 : last.status;
		const message = !last ? "Couldn't reach the AI provider. Try again."
			: status === 503 && last.status !== 503 ? "That model can't be reached right now. Pick another, or try again later."
			: status === 429 ? "That model is busy right now. Try again in a minute, or pick another."
			: last.message;
		return json({ error: { message, code: status } }, status);
	}
	// what the person is shown is what they were charged, in credit-dollars
	const shown = (usage, mc) => ({ ...usage, cost: (mc / 1000) * c.creditUsd, credits: mc / 1000 });

	if (!b.stream) {
		let j = await r.json().catch(() => null);
		if (j && way.kind === "claude") j = fromClaude(j, b.model);
		else if (j && way.kind === "responses") j = fromResponses(j, b.model);
		if (!j || !Array.isArray(j.choices)) {
			await settle(way, j && j.usage, 0);
			return json({ error: { message: "The model sent back nothing usable. Try again.", code: 502 } }, 502);
		}
		const mc = await settle(way, j.usage, (j.choices[0]?.message?.content || "").length);
		j.usage = shown(j.usage || {}, mc);
		return json(j);
	}

	// The stream as OpenAI's chunks whichever way it came, and its usage as one chunk of its own at the end, after the
	// charge: some ways send usage in every chunk, some once, Anthropic and the Responses API in their own events
	const { readable, writable } = new TransformStream();
	ctx.waitUntil((async () => {
		const reader = r.body.getReader();
		const writer = writable.getWriter();
		const conv = way.kind === "claude" ? claudeStream(b.model) : way.kind === "responses" ? responsesStream(b.model) : null;
		let buf = "", outChars = 0, usage = null, ended = false;
		const used = () => (conv ? conv.usage() : usage);
		const end = async () => {
			if (ended) return;
			ended = true;
			const mc = await settle(way, used(), outChars);
			const tail = mc == null ? "" : "data: " + JSON.stringify({ id: "usage", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: b.model, choices: [], usage: shown(used() || {}, mc) }) + "\n\n";
			await writer.write(enc.encode(tail + "data: [DONE]\n\n"));
		};
		try {
			read: for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let out = "", i;
				while ((i = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, i).trim();
					buf = buf.slice(i + 1);
					// keep-alives keep the connection open while a model thinks or searches
					if (line.startsWith(":")) { out += ": keep-alive\n\n"; continue; }
					if (!line.startsWith("data:")) continue;
					const data = line.slice(5).trim();
					if (data === "[DONE]") {
						if (out) await writer.write(enc.encode(out));
						await end();
						break read;
					}
					let j;
					try { j = JSON.parse(data); } catch { continue; }
					if (conv && (j.type === "ping" || /^response\.(web_search_call|in_progress|created)/.test(j.type || ""))) out += ": keep-alive\n\n";
					for (const x of conv ? conv.feed(j) : [j]) {
						if (x.usage) {
							usage = x.usage;
							delete x.usage;
							if (!(Array.isArray(x.choices) && x.choices.length) && !x.error) continue;
						}
						outChars += (x.choices?.[0]?.delta?.content || "").length;
						out += "data: " + JSON.stringify(x) + "\n\n";
					}
					if (conv && conv.finished) {
						if (out) await writer.write(enc.encode(out));
						await end();
						break read;
					}
				}
				if (out) await writer.write(enc.encode(out));
			}
			await end();
		} catch {
			try { await reader.cancel(); } catch {}
		} finally {
			await settle(way, used(), outChars);
			try { await writer.close(); } catch {}
		}
	})());
	return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

// ------------------------------------------------------------------ the studio: video, images, voice
//
// The same rule as chat: the worst case is held before anything is sent, the real cost is charged when it's known, the
// rest goes back. A video is a job that finishes minutes later, so what's held is written down (jobs) and settled once,
// by whichever poll first sees it finished, failed or gone.

const media = (c) => {
	const mult = Number(c.multipliers.media) || 2;
	return {
		mult,
		toMc: (usd) => Math.ceil((usd * mult / c.creditUsd) * 1000 - 1e-6),
		toUsd: (mc) => (mc / 1000) * c.creditUsd / mult,
	};
};
async function hold(env, user, mc, c) {
	const held = await take(env, user.id, mc, c);
	if (!held) {
		if (spendable(user) < 1000) throw outOfCredits(user, c);
		throw fail(402, "This needs about " + Math.ceil(mc / 1000) + " credits and you have " + Math.floor(spendable(user) / 1000) + ". Buy credits, or pick a cheaper quality.");
	}
	return held;
}
async function charge(env, userId, model, held, usd, mt) {
	const charged = mt.toMc(usd);
	await env.DB.batch([
		giveBack(env, userId, held, charged),
		env.DB.prepare("INSERT INTO usage (user_id, model, cost_usd, charged_mc, created_at) VALUES (?, ?, ?, ?, ?)").bind(userId, model, usd, charged, now()),
	]);
	return charged;
}
const orHeaders = (env) => ({ Authorization: "Bearer " + env.OPENROUTER_KEY, "Content-Type": "application/json", "HTTP-Referer": env.SITE_URL || "https://andromeda.app", "X-Title": "Andromeda" });
// the studio's models are WaveSpeed's (WAVESPEED_KEY) or OpenRouter's
function studioOpen(env) {
	if (!env.OPENROUTER_KEY && !wsOn(env)) throw fail(503, "Pictures, videos and voice aren't on this server yet.");
}

let VPRICES = { at: 0, map: new Map() };
async function videoModels(env) {
	if (Date.now() - VPRICES.at < 3600e3 && VPRICES.map.size) return VPRICES.map;
	const j = await (await fetch(orBase(env) + "/videos/models")).json();
	const map = new Map();
	for (const m of j.data || []) map.set(m.id, m);
	if (map.size) VPRICES = { at: Date.now(), map };
	return map;
}
// The most a clip can cost: per-second prices from the model's SKUs (dollars, cents, or video tokens), the ones that
// match the asked resolution and sound when they say, the dearest of those times the length.
function videoWorstUsd(model, b) {
	const skus = model.pricing_skus || {};
	const secs = Math.max(1, Math.min(60, Number(b.duration) || 8));
	const res = String(b.resolution || "").toLowerCase();
	const audio = b.generate_audio !== false;
	const [w, h] = { "480p": [854, 480], "720p": [1280, 720], "768p": [1366, 768], "1080p": [1920, 1080], "2k": [2560, 1440], "4k": [3840, 2160] }[res] || [1920, 1080];
	const perSec = (k, v) => /video_tokens/.test(k) ? v * w * h * 24 / 1024 : /cents/.test(k) ? v / 100 : /duration_seconds/.test(k) ? v : 0;
	let all = 0, fit = 0;
	for (const [k, raw] of Object.entries(skus)) {
		const v = Number(raw);
		if (!Number.isFinite(v) || /input|reference|minimum|continuation/.test(k)) continue;
		const ps = perSec(k, v);
		all = Math.max(all, ps);
		const kRes = (k.match(/(480p|720p|768p|1080p|2k|4k)/) || [])[1];
		if ((!kRes || kRes === res) && !(audio && /without_audio/.test(k)) && !(!audio && /with_audio/.test(k))) fit = Math.max(fit, ps);
	}
	const min = Number(skus.minimum_cents_per_generation || 0) / 100;
	return Math.max(min, (fit || all || 0.5) * secs) * 1.1;
}
async function videoSubmit(req, env, user) {
	studioOpen(env);
	const c = await config(env), mt = media(c);
	const b = await body(req);
	const wf = await wsHas(env, b.model, "video");
	if (wf) return wsVideoSubmit(env, user, wf, b, c, mt);
	orStudio(env, "video");
	const model = (await videoModels(env)).get(String(b.model || ""));
	if (!model) throw fail(400, "That video model isn't available.");
	const reserve = mt.toMc(videoWorstUsd(model, b));
	const held = await hold(env, user, reserve, c);
	let r, j;
	try {
		r = await fetch(orBase(env) + "/videos", { method: "POST", headers: orHeaders(env), body: JSON.stringify({ ...b, callback_url: undefined, user: user.id }) });
		j = await r.json();
	} catch {
		await charge(env, user.id, b.model, held, 0, mt);
		throw fail(502, "Couldn't reach the video provider. Try again.");
	}
	if (!r.ok || !j.id) {
		await charge(env, user.id, b.model, held, 0, mt);
		return json({ error: { message: j?.error?.message || "The video couldn't be started.", code: r.status } }, r.ok ? 502 : r.status);
	}
	await env.DB.prepare("INSERT INTO jobs (id, user_id, model, reserve_mc, from_free, settled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)").bind(j.id, user.id, b.model, reserve, held.fromFree, now()).run();
	return json({ id: j.id, status: j.status || "pending" }, 202);
}
async function ownJob(env, user, jobId) {
	const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(jobId, user.id).first();
	if (!job) throw fail(404, "No such video.");
	return job;
}
async function videoPoll(env, user, jobId) {
	const c = await config(env), mt = media(c);
	const job = await ownJob(env, user, jobId);
	if (jobId.startsWith("ws-")) return wsVideoPoll(env, user, job, c, mt);
	const r = await fetch(orBase(env) + "/videos/" + jobId, { headers: orHeaders(env) });
	const j = await r.json().catch(() => ({}));
	const status = j.status || (r.status === 404 ? "expired" : "in_progress");
	const done = status === "completed", gone = /failed|cancelled|expired/.test(status);
	if ((done || gone) && !job.settled) {
		// only one poll gets to settle it
		const mine = await env.DB.prepare("UPDATE jobs SET settled = 1 WHERE id = ? AND settled = 0").bind(jobId).run();
		if (mine.meta && mine.meta.changes) {
			const usd = done ? Number(j.usage?.cost) : 0;
			const held = { fromFree: job.from_free || 0, fromPaid: job.reserve_mc - (job.from_free || 0) };
			const charged = await charge(env, user.id, job.model, held, Number.isFinite(usd) ? usd : mt.toUsd(job.reserve_mc), mt);
			j.usage = { ...(j.usage || {}), cost: (charged / 1000) * c.creditUsd, credits: charged / 1000 };
		}
	} else if (j.usage) j.usage = { cost: 0 };
	// the files are fetched through here (the owner's key never leaves the server)
	if (Array.isArray(j.unsigned_urls)) j.unsigned_urls = j.unsigned_urls.map((_, i) => "/api/videos/" + jobId + "/content?index=" + i);
	return json({ id: jobId, status, unsigned_urls: j.unsigned_urls || [], usage: j.usage, error: j.error });
}
async function videoContent(env, user, jobId, url) {
	await ownJob(env, user, jobId);
	const index = Math.max(0, Math.min(9, Number(url.searchParams.get("index")) || 0));
	if (jobId.startsWith("ws-")) {
		const d = await wsResult(env, jobId.slice(3));
		const u = (d.outputs || []).filter((o) => typeof o === "string")[index];
		if (d.status !== "completed" || !u) throw fail(404, "That video isn't ready or has expired.");
		const r = await wsFile(u);
		return new Response(r.body, { headers: { "Content-Type": mediaType(r, u, "video/mp4"), "Cache-Control": "private, max-age=3600" } });
	}
	const r = await fetch(orBase(env) + "/videos/" + jobId + "/content?index=" + index, { headers: { Authorization: "Bearer " + env.OPENROUTER_KEY } });
	if (!r.ok) throw fail(r.status === 404 ? 404 : 502, "That video isn't ready or has expired.");
	return new Response(r.body, { headers: { "Content-Type": r.headers.get("Content-Type") || "video/mp4", "Cache-Control": "private, max-age=3600" } });
}

async function imageGen(req, env, user) {
	studioOpen(env);
	const c = await config(env), mt = media(c);
	const b = await body(req);
	if (typeof b.model !== "string") throw fail(400, "Pick an image model.");
	const wf = await wsHas(env, b.model, "image");
	if (wf) return wsImage(env, user, wf, b, c, mt);
	orStudio(env, "image");
	const n = Math.max(1, Math.min(4, Number(b.n) || 1));
	const big = /4k/i.test(b.resolution || "") ? 2.5 : /2k/i.test(b.resolution || "") ? 1.6 : 1;
	const reserve = mt.toMc(0.3 * big * n);
	const held = await hold(env, user, reserve, c);
	let r, j;
	try {
		r = await fetch(orBase(env) + "/images", { method: "POST", headers: orHeaders(env), body: JSON.stringify({ ...b, n, stream: false, user: user.id }) });
		j = await r.json();
	} catch {
		await charge(env, user.id, b.model, held, 0, mt);
		throw fail(502, "Couldn't reach the image provider. Try again.");
	}
	if (!r.ok || !Array.isArray(j.data)) {
		await charge(env, user.id, b.model, held, 0, mt);
		return json({ error: { message: j?.error?.message || "The image couldn't be made.", code: r.status } }, r.ok ? 502 : r.status);
	}
	const usd = Number(j.usage?.cost);
	const charged = await charge(env, user.id, b.model, held, Number.isFinite(usd) ? usd : 0.15 * big * j.data.length, mt);
	j.usage = { ...(j.usage || {}), cost: (charged / 1000) * c.creditUsd, credits: charged / 1000 };
	return json(j);
}

let SPRICES = { at: 0, map: new Map() };
async function speech(req, env, user) {
	studioOpen(env);
	const c = await config(env), mt = media(c);
	const b = await body(req);
	const text = Array.isArray(b.input) ? b.input.map((x) => x.text || "").join(" ") : String(b.input || "");
	if (!text.trim() || text.length > 10000) throw fail(400, "Give the voice between 1 and 10,000 characters.");
	const wf = await wsHas(env, b.model, "speech");
	if (wf) return wsAudio(env, user, wf, { prompt: text, voice: b.voice, format: "mp3" }, b.model, c, mt);
	orStudio(env, "voice");
	if (!(Date.now() - SPRICES.at < 3600e3 && SPRICES.map.size)) {
		const j = await (await fetch(orBase(env) + "/models?output_modalities=speech")).json();
		const map = new Map();
		for (const m of j.data || []) map.set(m.id, Number(m.pricing?.prompt || 0));
		if (map.size) SPRICES = { at: Date.now(), map };
	}
	if (!SPRICES.map.has(b.model)) throw fail(400, "That voice model isn't available.");
	// priced per character (a few per second of audio); a per-second model is held at a generous guess
	const usd = Math.max(0.002, text.length * (SPRICES.map.get(b.model) || 0.0001));
	const reserve = mt.toMc(usd * 1.2);
	const held = await hold(env, user, reserve, c);
	let r;
	try {
		r = await fetch(orBase(env) + "/audio/speech", { method: "POST", headers: orHeaders(env), body: JSON.stringify(b) });
	} catch {
		await charge(env, user.id, b.model, held, 0, mt);
		throw fail(502, "Couldn't reach the voice provider. Try again.");
	}
	if (!r.ok) {
		await charge(env, user.id, b.model, held, 0, mt);
		let msg = r.statusText;
		try { msg = (await r.json()).error?.message || msg; } catch {}
		return json({ error: { message: msg, code: r.status } }, r.status);
	}
	const charged = await charge(env, user.id, b.model, held, usd, mt);
	return new Response(r.body, { headers: { "Content-Type": r.headers.get("Content-Type") || "audio/mpeg", "X-Credits": String(charged / 1000), "Access-Control-Expose-Headers": "X-Credits" } });
}

// Music: a song from a prompt (WaveSpeed's music models; on OpenRouter, Lyria is reached through chat instead)
async function music(req, env, user) {
	studioOpen(env);
	const c = await config(env), mt = media(c);
	const b = await body(req);
	const prompt = String(b.prompt || "").trim();
	if (!prompt || prompt.length > 4000) throw fail(400, "Describe the song in up to 4,000 characters.");
	const wf = await wsHas(env, b.model, "music");
	if (!wf) throw fail(400, "That music model isn't available.");
	return wsAudio(env, user, wf, { prompt, format: "mp3" }, b.model, c, mt);
}

// ------------------------------------------------------------------ WaveSpeed: pictures, video, voice and music
// With WAVESPEED_KEY set, the studio runs on WaveSpeed. Its list of models says what each one takes (a JSON schema
// each), so a request is put in that model's own words: "aspect_ratio" or a "size" like "1280*720", "images" or
// "image", "text" or "prompt". Pictures the browser sends as data are uploaded first (models take links), and
// WaveSpeed prices every request itself before it's made. "google/nano-banana-pro/text-to-image" and ".../edit" are
// one model to the site: made from words, or from the pictures it's given.
const WSAPI = "https://api.wavespeed.ai/api/v3";
const wsOn = (env) => !!(env.WAVESPEED_KEY && String(env.WAVESPEED_KEY).trim());
const wsAuth = (env) => ({ Authorization: "Bearer " + String(env.WAVESPEED_KEY).trim() });
const WS_TASK = /^(text-to-image|image-to-image|edit|text-to-video|image-to-video)(?:-(turbo|fast|lite|pro))?$/;
// the names the leaderboards know them by, so the site ranks them like any other
const WS_NAMES = {
	"google/nano-banana-pro": "Gemini 3 Pro Image", "google/nano-banana-2": "Gemini 3.1 Flash Image", "google/nano-banana-2.1": "Gemini Nano Banana 2.1",
	"bytedance/seedream-v5.0-pro": "Seedream 5.0 Pro", "bytedance/seedream-v5.0-flash": "Seedream 5.0 Flash", "openai/gpt-image-2": "GPT Image 2",
};
// ElevenLabs' own voices, the ones the site casts: WaveSpeed takes them by name ("George")
const WS_ELEVEN = ["george", "sarah", "adam", "alice", "bella", "bill", "brian", "callum", "charlie", "chris", "daniel", "eric", "jessica", "laura", "liam", "lily", "matilda", "river", "roger", "will"];
let WSMEDIA = { at: 0, fams: new Map() };
async function wsFamilies(env) {
	if (WSMEDIA.fams.size && Date.now() - WSMEDIA.at < 6 * 3600e3) return WSMEDIA.fams;
	let list = [];
	try {
		const r = await fetch(WSAPI + "/models", { headers: wsAuth(env), signal: AbortSignal.timeout(15000) });
		const j = await r.json();
		list = Array.isArray(j.data) ? j.data : [];
	} catch {}
	const fams = new Map();
	for (const m of list) {
		const id = String(m.model_id || ""), type = String(m.type || ""), parts = id.split("/");
		if (parts.length < 2) continue;
		const runs = m.api_schema?.api_schemas || [];
		const run = runs.find((s) => s.type === "model_run") || runs[0] || {};
		const kinds = { "text-to-image": ["image", "make"], "image-to-image": ["image", "from"], "text-to-video": ["video", "make"], "image-to-video": ["video", "from"] };
		let [kind, slot] = kinds[type] || [];
		if (type === "text-to-audio") [kind, slot] = [/music|song|lyria|suno|udio|ace-?step/i.test(id) ? "music" : "speech", "make"];
		if (!kind) continue;
		const t = parts[parts.length - 1].match(WS_TASK);
		const fam = t ? parts.slice(0, -1).join("/") + (t[2] ? "-" + t[2] : "") : id;
		const f = fams.get(fam) || { id: fam, kind, name: WS_NAMES[fam] || "", make: null, from: null };
		// the first of each kept (one family is never both a picture and a video model)
		if (f.kind !== kind || f[slot]) continue;
		f[slot] = { id, schema: run.request_schema || {}, price: Number(m.base_price) || 0 };
		fams.set(fam, f);
	}
	if (fams.size) WSMEDIA = { at: Date.now(), fams };
	return fams;
}
async function wsHas(env, model, kind) {
	if (!wsOn(env)) return null;
	const f = (await wsFamilies(env)).get(String(model || ""));
	return f && f.kind === kind ? f : null;
}
// a request for a model WaveSpeed doesn't have goes to OpenRouter, when there's a key for it
function orStudio(env, what) {
	if (!env.OPENROUTER_KEY) throw fail(400, "That " + what + " model isn't available.");
}

const wsProps = (schema) => (schema && schema.properties) || {};
const wsField = (schema, names) => names.find((n) => wsProps(schema)[n]) || null;
const WS_TEXT = ["prompt", "text", "input"], WS_MANY = ["images", "image_urls", "reference_images", "input_images"], WS_ONE = ["image", "image_url", "input_image"];
const WS_FRAME = ["image", "first_frame", "first_frame_image", "start_image", "image_url", "input_image"], WS_AUDIO = ["generate_audio", "enable_audio", "audio", "sound", "with_audio"];
const WS_COUNT = ["num_images", "number_of_images", "n"], WS_VOICE = ["voice_id", "voice"];
const ratioOf = (s) => { const m = String(s).match(/^(\d+(?:\.\d+)?)\s*[:*x]\s*(\d+(?:\.\d+)?)$/i); return m ? m[1] / m[2] : 0; };
const resNum = (s) => { const m = String(s).toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(k|p)?$/); return !m ? 0 : m[2] === "k" ? m[1] * 1000 : Number(m[1]); };
// a value a model takes: the same one in its list, or the nearest; a number kept in its range
function wsFit(spec, value, how) {
	if (!spec || value == null || value === "") return undefined;
	if (Array.isArray(spec.enum) && spec.enum.length) {
		const same = spec.enum.find((x) => String(x).toLowerCase() === String(value).toLowerCase());
		if (same !== undefined) return same;
		const dist = how === "ratio" ? (x) => Math.abs(Math.log((ratioOf(x) || 1) / (ratioOf(value) || 1))) : how === "res" ? (x) => Math.abs(resNum(x) - resNum(value)) : how === "number" ? (x) => Math.abs(Number(x) - Number(value)) : null;
		return dist ? spec.enum.slice().sort((a, b) => dist(a) - dist(b))[0] : undefined;
	}
	if (spec.type === "integer" || spec.type === "number") {
		let n = Number(value);
		if (!Number.isFinite(n)) return undefined;
		if (Number.isFinite(spec.minimum)) n = Math.max(spec.minimum, n);
		if (Number.isFinite(spec.maximum)) n = Math.min(spec.maximum, n);
		return spec.type === "integer" ? Math.round(n) : n;
	}
	if (spec.type === "boolean") return !!value;
	return value;
}
// what the site asked for, in this model's own words; anything it requires and wasn't given, its default
function wsInputs(schema, want) {
	const p = wsProps(schema), out = {};
	const put = (names, value, how) => {
		const k = wsField(schema, names);
		const v = k ? wsFit(p[k], value, how) : undefined;
		if (v !== undefined) out[k] = v;
		return k;
	};
	put(WS_TEXT, want.prompt);
	if (want.ar && !put(["aspect_ratio", "ratio"], want.ar, "ratio") && Array.isArray(p.size?.enum)) {
		// a list of sizes ("1280*720"): the nearest shape, then the nearest size ("2K" about 2048x2048, "720p" 1280x720)
		const r = resNum(want.res), area = !r ? 1024 * 1024 : r >= 1000 ? Math.pow(r * 1.024, 2) : (r * r * 16) / 9;
		const px = (s) => String(s).split(/[*x:]/i).map(Number);
		const score = (s) => Math.abs(Math.log((ratioOf(s) || 1) / (ratioOf(want.ar) || 1))) * 10 + Math.abs(Math.log((px(s)[0] * px(s)[1] || 1) / area));
		out.size = p.size.enum.slice().sort((a, b) => score(a) - score(b))[0];
	}
	put(["resolution"], want.res, "res");
	put(["duration", "duration_seconds"], want.duration, "number");
	if (want.refs?.length) {
		const many = wsField(schema, WS_MANY);
		if (many) out[many] = want.refs.slice(0, Number(p[many].maxItems) || want.refs.length);
		else put(WS_ONE, want.refs[0]);
	}
	if (want.frame) {
		const k = wsField(schema, WS_FRAME);
		if (k) out[k] = p[k].type === "array" ? [want.frame] : want.frame;
	}
	if (want.audio) put(WS_AUDIO, true);
	if (want.n > 1) put(WS_COUNT, want.n, "number");
	if (want.voice) {
		const k = wsField(schema, WS_VOICE);
		if (k) out[k] = Array.isArray(p[k].enum) ? wsFit(p[k], want.voice) ?? p[k].default ?? p[k].enum[0] : String(want.voice).replace(/^./, (x) => x.toUpperCase());
	}
	if (want.format) put(["output_format", "format"], want.format);
	// answers in the same reply where the model can (pictures and sound take seconds; video is checked on instead)
	if (want.sync && p.enable_sync_mode) out.enable_sync_mode = true;
	for (const k of Array.isArray(schema.required) ? schema.required : []) {
		if (out[k] !== undefined || !p[k]) continue;
		if (p[k].default !== undefined) out[k] = p[k].default;
		else if (Array.isArray(p[k].enum) && p[k].enum.length) out[k] = p[k].enum[0];
	}
	return out;
}

// what WaveSpeed will charge for exactly this (its list price, before any discount on the owner's account)
async function wsPrice(env, modelId, inputs, guess) {
	try {
		const r = await fetch(WSAPI + "/model/price", { method: "POST", headers: { ...wsAuth(env), "Content-Type": "application/json" }, body: JSON.stringify({ model_id: modelId, inputs }), signal: AbortSignal.timeout(10000) });
		const j = await r.json();
		const usd = Number(j.data?.price ?? j.data?.discounted_price);
		if (r.ok && Number.isFinite(usd) && usd >= 0) return usd;
	} catch {}
	return guess;
}
// a picture the browser sent as data: uploaded, so the model gets a link
async function wsLink(env, url) {
	const m = String(url || "").match(/^data:([^;,]*)(;base64)?,(.*)$/s);
	if (!m) return url;
	const bytes = m[2] ? Uint8Array.from(atob(m[3]), (ch) => ch.charCodeAt(0)) : enc.encode(decodeURIComponent(m[3]));
	const type = m[1] || "image/png";
	const fd = new FormData();
	fd.append("file", new Blob([bytes], { type }), "input." + ((type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png"));
	const r = await fetch(WSAPI + "/media/upload/binary", { method: "POST", headers: wsAuth(env), body: fd });
	const j = await r.json().catch(() => ({}));
	if (!r.ok || !j.data?.download_url) throw fail(502, "Couldn't hand the picture to the model. Try again.");
	return j.data.download_url;
}
const wsError = (j) => String(j?.data?.error || j?.error?.message || (typeof j?.error === "string" ? j.error : "") || j?.message || "");
async function wsResult(env, id) {
	const r = await fetch(WSAPI + "/predictions/" + encodeURIComponent(id) + "/result", { headers: wsAuth(env) });
	const j = await r.json().catch(() => ({}));
	return j.data || { id, status: r.status === 404 ? "deleted" : "processing" };
}
const wsGone = (status) => /failed|cancelled|timeout|deleted/.test(String(status || ""));
// started; with `waitMs`, also waited for (a sync reply that ran out of time is checked on, never sent again: that
// would start, and pay for, a second one)
async function wsRun(env, modelId, inputs, waitMs) {
	const r = await fetch(WSAPI + "/" + modelId, { method: "POST", headers: { ...wsAuth(env), "Content-Type": "application/json" }, body: JSON.stringify(inputs) });
	const j = await r.json().catch(() => ({}));
	let d = j.data || {};
	if (!r.ok || !d.id) throw fail(r.status === 401 || r.status === 403 ? 503 : r.status === 400 ? 400 : 502, wsError(j) || "The model couldn't start. Try again.");
	const end = Date.now() + (waitMs || 0);
	while (waitMs) {
		if (d.status === "completed") return d;
		if (wsGone(d.status)) throw fail(502, wsError({ data: d }) || "The model couldn't make it. Try again.");
		if (Date.now() > end) throw fail(504, "The model is taking too long. Try again.");
		await new Promise((res) => setTimeout(res, 2000));
		d = await wsResult(env, d.id);
	}
	return d;
}
async function wsFile(url) {
	const r = await fetch(url);
	if (!r.ok) throw fail(502, "The finished file couldn't be fetched. Try again.");
	return r;
}
function mediaType(r, url, fallback) {
	const t = (r.headers.get("Content-Type") || "").split(";")[0];
	if (/^(image|audio|video)\//.test(t)) return t;
	const ext = (String(url).split("?")[0].match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
	return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm" }[ext] || fallback;
}
function toB64(buf) {
	const a = new Uint8Array(buf);
	let s = "";
	for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
	return btoa(s);
}

// The site's list of studio models, in the shapes it reads OpenRouter's in
async function wsCatalog(env) {
	const out = { image: [], video: [], speech: [], music: [] };
	for (const f of (await wsFamilies(env)).values()) {
		const base = f.make || f.from;
		if (!base || (f.kind !== "video" && !f.make)) continue;
		const p = wsProps(base.schema), name = f.name || f.id.split("/").slice(1).join(" ");
		const en = (k) => (Array.isArray(p[k]?.enum) ? p[k].enum.map(String) : []);
		const ar = en("aspect_ratio").length ? en("aspect_ratio") : [...new Set(en("size").map((s) => { const [w, h] = s.split(/[*x]/i).map(Number); if (!w || !h) return ""; const g = (a, b) => (b ? g(b, a % b) : a); return w / g(w, h) + ":" + h / g(w, h); }).filter(Boolean))];
		if (f.kind === "image") {
			const fp = f.from ? wsProps(f.from.schema) : {}, many = f.from && wsField(f.from.schema, WS_MANY);
			const refs = !f.from ? 0 : many ? Number(fp[many].maxItems) || 4 : wsField(f.from.schema, WS_ONE) ? 1 : 0;
			out.image.push({ id: f.id, name, supported_parameters: { aspect_ratio: { values: ar }, resolution: { values: en("resolution").map((r) => (/^\d+k$/i.test(r) ? r.toUpperCase() : r)) }, input_references: { max: refs } }, price: base.price });
		} else if (f.kind === "video") {
			const d = p.duration || p.duration_seconds || {};
			const durations = Array.isArray(d.enum) ? d.enum.map(Number) : Number.isFinite(d.minimum) && Number.isFinite(d.maximum) ? [d.minimum, d.maximum] : [];
			const per = Number(d.default) || durations[0] || 5;
			out.video.push({ id: f.id, name, supported_durations: durations, supported_resolutions: en("resolution"), supported_aspect_ratios: ar, supported_frame_images: f.from ? ["first_frame"] : [], generate_audio: wsField(base.schema, WS_AUDIO) ? true : false, pricing_skus: { duration_seconds: base.price / per }, from_words: !!f.make });
		} else if (f.kind === "speech") {
			const vf = wsField(base.schema, WS_VOICE);
			const voices = vf && Array.isArray(p[vf].enum) ? p[vf].enum.map(String) : /eleven/i.test(f.id) ? WS_ELEVEN : vf && p[vf].default ? [String(p[vf].default)] : [];
			out.speech.push({ id: f.id, name, supported_voices: voices, pricing: { prompt: base.price / 1000 } });
		} else out.music.push({ id: f.id, name, music: true });
	}
	return out;
}

async function wsImage(env, user, f, b, c, mt) {
	const n = Math.max(1, Math.min(4, Number(b.n) || 1));
	const given = (Array.isArray(b.input_references) ? b.input_references : []).map((x) => (typeof x === "string" ? x : x?.image_url?.url || x?.image_url)).filter((x) => typeof x === "string");
	const v = given.length && f.from ? f.from : f.make;
	const refs = v === f.from ? await Promise.all(given.slice(0, 8).map((u) => wsLink(env, u))) : [];
	const inputs = wsInputs(v.schema, { prompt: String(b.prompt || ""), ar: b.aspect_ratio, res: b.resolution, refs, n, format: "png", sync: true });
	// several at once where the model makes several; otherwise one request each
	const runs = wsField(v.schema, WS_COUNT) && inputs[wsField(v.schema, WS_COUNT)] > 1 ? 1 : n;
	const each = await wsPrice(env, v.id, inputs, (v.price || 0.15) * (runs === 1 ? n : 1));
	const held = await hold(env, user, mt.toMc(each * runs * 1.1), c);
	const done = await Promise.allSettled(Array.from({ length: runs }, () => wsRun(env, v.id, inputs, 110e3)));
	const ok = done.filter((x) => x.status === "fulfilled").map((x) => x.value);
	try {
		if (!ok.length) throw done[0].reason;
		const urls = ok.flatMap((d) => (d.outputs || []).filter((o) => typeof o === "string")).slice(0, n);
		const data = await Promise.all(urls.map(async (u) => {
			if (u.startsWith("data:")) return { b64_json: u.split(",")[1], media_type: u.slice(5).split(/[;,]/)[0] || "image/png" };
			const r = await wsFile(u);
			return { b64_json: toB64(await r.arrayBuffer()), media_type: mediaType(r, u, "image/png") };
		}));
		// what was made is paid for, even if a copy failed
		const charged = await charge(env, user.id, b.model, held, each * ok.length, mt);
		return json({ data, usage: { cost: (charged / 1000) * c.creditUsd, credits: charged / 1000 } });
	} catch (e) {
		await charge(env, user.id, b.model, held, 0, mt);
		throw e.status ? e : fail(502, "The image couldn't be made. Try again.");
	}
}

// voice and music: the sound for a text or a prompt. A text longer than the model takes at once is read in pieces,
// split between sentences, one after another (MP3 pieces play back to back as one file)
async function wsAudio(env, user, f, want, model, c, mt) {
	const v = f.make, tk = wsField(v.schema, WS_TEXT), max = Number(wsProps(v.schema)[tk]?.maxLength) || 0;
	const pieces = [];
	let rest = want.prompt;
	while (max && rest.length > max) {
		const cut = Math.max(rest.lastIndexOf(". ", max), rest.lastIndexOf("\n", max), rest.lastIndexOf(" ", max));
		const at = cut > max * 0.5 ? cut + 1 : max;
		pieces.push(rest.slice(0, at).trim());
		rest = rest.slice(at);
	}
	if (rest.trim()) pieces.push(rest.trim());
	const asks = pieces.map((p) => wsInputs(v.schema, { ...want, prompt: p, sync: true }));
	const usd = (await Promise.all(asks.map((inputs, i) => wsPrice(env, v.id, inputs, Math.max(0.002, pieces[i].length * (v.price || 0.2) / 1000))))).reduce((a, b) => a + b, 0);
	const held = await hold(env, user, mt.toMc(usd * 1.1), c);
	try {
		const parts = [];
		let type = "audio/mpeg";
		for (const inputs of asks) {
			const d = await wsRun(env, v.id, inputs, 110e3);
			const u = (d.outputs || []).find((o) => typeof o === "string");
			if (!u) throw fail(502, "The model didn't send any sound. Try again.");
			const r = await wsFile(u);
			type = mediaType(r, u, type);
			parts.push(new Uint8Array(await r.arrayBuffer()));
		}
		const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
		let o = 0;
		for (const p of parts) { all.set(p, o); o += p.length; }
		const charged = await charge(env, user.id, model, held, usd, mt);
		return new Response(all, { headers: { "Content-Type": type, "X-Credits": String(charged / 1000), "Access-Control-Expose-Headers": "X-Credits" } });
	} catch (e) {
		await charge(env, user.id, model, held, 0, mt);
		throw e.status ? e : fail(502, "The sound couldn't be made. Try again.");
	}
}

// a video is a job: started here, checked on by the site, paid for once it's finished (nothing if it fails)
async function wsVideoSubmit(env, user, f, b, c, mt) {
	const fr = (Array.isArray(b.frame_images) ? b.frame_images : []).find((x) => x && x.frame_type !== "last_frame");
	const frameUrl = fr ? (typeof fr.image_url === "string" ? fr.image_url : fr.image_url?.url) : null;
	const v = frameUrl && f.from ? f.from : f.make;
	if (!v) throw fail(400, "This video model starts from a picture.");
	const frame = v === f.from ? await wsLink(env, frameUrl) : null;
	const inputs = wsInputs(v.schema, { prompt: String(b.prompt || ""), ar: b.aspect_ratio, res: b.resolution, duration: b.duration, audio: !!b.generate_audio, frame });
	const usd = await wsPrice(env, v.id, inputs, (v.price || 0.3) * Math.max(1, (Number(b.duration) || 5) / 5));
	const reserve = mt.toMc(usd);
	const held = await hold(env, user, reserve, c);
	let d;
	try {
		d = await wsRun(env, v.id, inputs, 0);
	} catch (e) {
		await charge(env, user.id, b.model, held, 0, mt);
		throw e;
	}
	const id = "ws-" + d.id;
	await env.DB.prepare("INSERT INTO jobs (id, user_id, model, reserve_mc, from_free, settled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)").bind(id, user.id, b.model, reserve, held.fromFree, now()).run();
	return json({ id, status: "pending" }, 202);
}
async function wsVideoPoll(env, user, job, c, mt) {
	const d = await wsResult(env, job.id.slice(3));
	const done = d.status === "completed", gone = wsGone(d.status);
	const status = done ? "completed" : gone ? "failed" : "in_progress";
	let usage = { cost: 0 };
	if ((done || gone) && !job.settled) {
		// only one check gets to settle it
		const mine = await env.DB.prepare("UPDATE jobs SET settled = 1 WHERE id = ? AND settled = 0").bind(job.id).run();
		if (mine.meta && mine.meta.changes) {
			const held = { fromFree: job.from_free || 0, fromPaid: job.reserve_mc - (job.from_free || 0) };
			const charged = await charge(env, user.id, job.model, held, done ? mt.toUsd(job.reserve_mc) : 0, mt);
			usage = { cost: (charged / 1000) * c.creditUsd, credits: charged / 1000 };
		}
	}
	const outs = done ? (d.outputs || []).filter((o) => typeof o === "string") : [];
	return json({ id: job.id, status, unsigned_urls: outs.map((_, i) => "/api/videos/" + job.id + "/content?index=" + i), usage, error: gone ? wsError({ data: d }) || "The video model couldn't make this shot." : undefined });
}

// ------------------------------------------------------------------ tools the models use (signed-in users only)
//
// Docs: Context7's up-to-date documentation for any library (the model asks for "react", "fabric api", "pandas"...),
// so code is written against today's API, not the one it remembers. Fetch: a page someone linked, as plain text.
// Neither lets a browser call those sites directly (no CORS), so they come through here.

const C7 = "https://context7.com/api/v1";
async function toolDocs(req, env) {
	const b = await body(req);
	const lib = String(b.library || "").trim().slice(0, 80), topic = String(b.topic || "").trim().slice(0, 120);
	if (!lib) throw fail(400, "Which library?");
	const h = env.CONTEXT7_KEY ? { Authorization: "Bearer " + env.CONTEXT7_KEY } : {};
	let r = await fetch(C7 + "/search?query=" + encodeURIComponent(lib), { headers: h });
	if (!r.ok) throw fail(502, "The docs service is busy. Try again.");
	const found = ((await r.json()).results || []).filter((x) => x.state === "finalized" || !x.state);
	// the library they named (three.js is three.js, not something built on it), then trusted, well covered, popular
	const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
	const want = norm(lib);
	const named = (x) => { const t = norm(x.title), id = norm(String(x.id).split("/").pop()); return t === want || id === want ? 12 : t.startsWith(want) || id.startsWith(want) ? 5 : t.includes(want) || id.includes(want) ? 2 : 0; };
	const score = (x) => named(x) + (x.trustScore || 0) * 2 + Math.log10(1 + (x.stars || 0)) + (x.benchmarkScore || 0) / 40;
	found.sort((a, c) => score(c) - score(a));
	const pick = found[0];
	if (!pick) return json({ library: null, text: "" });
	const tokens = Math.max(1000, Math.min(8000, Number(b.tokens) || 5000));
	r = await fetch(C7 + pick.id + "?type=txt&tokens=" + tokens + (topic ? "&topic=" + encodeURIComponent(topic) : ""), { headers: h });
	const text = r.ok ? (await r.text()).slice(0, 40000) : "";
	return json({ library: pick.id, title: pick.title, text });
}

// a live web search for Andromeda working on its own (Tavily or Brave, when the server has a key for one)
async function toolSearch(req, env, user) {
	const b = await body(req);
	const q = String(b.query || "").trim();
	if (!q) throw fail(400, "Search for what?");
	if (!env.TAVILY_KEY && !env.BRAVE_KEY && !env.WAVESPEED_KEY && !env.OPENROUTER_KEY) throw fail(503, "Web search isn't set up on this server yet. Read pages directly with fetch_url instead.");
	return json({ results: await searchFor(env, user, q, Math.max(1, Math.min(10, Number(b.n) || 6))) });
}
async function toolFetch(req, env) {
	const b = await body(req);
	let u;
	try { u = new URL(String(b.url || "")); } catch { throw fail(400, "That isn't a link."); }
	if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/.test(u.hostname)) throw fail(400, "That link can't be opened.");
	let r;
	try {
		r = await fetch(u.toString(), { headers: { "User-Agent": "Mozilla/5.0 (compatible; Andromeda/1.0)", Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
	} catch { throw fail(502, "That page didn't answer."); }
	if (!r.ok) throw fail(502, "That page answered " + r.status + ".");
	const type = r.headers.get("Content-Type") || "";
	if (!/text|json|xml|javascript/.test(type)) return json({ url: u.toString(), title: "", text: "(not a text page: " + type + ")" });
	let t = (await r.text()).slice(0, 2_000_000);
	const title = (t.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
	if (/html/.test(type)) {
		t = t.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n").replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
			.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
	}
	return json({ url: u.toString(), title: title.replace(/\s+/g, " ").trim().slice(0, 200), text: t.slice(0, 30000) });
}

// ------------------------------------------------------------------ shared chats
// A chat its owner chose to share: a read-only copy of its words (no files, pictures or apps), at a link nobody can guess.
// Sharing it again updates the same link; the owner can stop sharing it.
async function shareMake(req, env, user) {
	const b = await body(req);
	const msgs = (Array.isArray(b.msgs) ? b.msgs : []).slice(0, 500).map((x) => ({ role: x && x.role === "user" ? "user" : "assistant", text: String((x && x.text) || "").slice(0, 60000) })).filter((x) => x.text.trim());
	if (!msgs.length) throw fail(400, "There's nothing in this chat to share yet.");
	const data = JSON.stringify(msgs), title = String(b.title || "").slice(0, 120);
	if (data.length > 900000) throw fail(413, "This chat is too long to share.");
	if (/^[a-f0-9]{24}$/.test(String(b.id || ""))) {
		const r = await env.DB.prepare("UPDATE shares SET title = ?, data = ?, created_at = ? WHERE id = ? AND user_id = ?").bind(title, data, now(), b.id, user.id).run();
		if (r.meta && r.meta.changes) return json({ id: b.id });
	}
	const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM shares WHERE user_id = ?").bind(user.id).first();
	if (n && n.n >= 500) throw fail(429, "You're sharing 500 chats already: stop sharing some old ones first.");
	const sid = id();
	await env.DB.prepare("INSERT INTO shares (id, user_id, title, data, created_at) VALUES (?, ?, ?, ?, ?)").bind(sid, user.id, title, data, now()).run();
	return json({ id: sid });
}
async function shareGet(env, sid) {
	const r = await env.DB.prepare("SELECT title, data, created_at FROM shares WHERE id = ?").bind(sid).first();
	if (!r) throw fail(404, "This chat isn't shared, or its owner stopped sharing it.");
	return json({ title: r.title || "Shared chat", msgs: JSON.parse(r.data), at: r.created_at });
}
async function shareDel(env, user, sid) {
	await env.DB.prepare("DELETE FROM shares WHERE id = ? AND user_id = ?").bind(sid, user.id).run();
	return json({ ok: true });
}

// ------------------------------------------------------------------ Andromeda's own measurements
// Every checked team answer says, piece by piece, whether that piece held up, with a few tags for exactly what the
// piece was ("python", "pandas", "csv-cleaning"). Added up across everyone, this measures which model is best at things
// no public leaderboard measures. Only tags and pass/fail are kept, never what anyone wrote.
const SKILL_TAG = /^[a-z0-9][a-z0-9+#.\-]{0,39}$/;
const cleanTag = (t) => String(t || "").toLowerCase().trim().replace(/\s+/g, "-").slice(0, 40);
async function skillsAdd(req, env, user) {
	const b = await body(req);
	const results = (Array.isArray(b.results) ? b.results : []).slice(0, 64);
	const rows = [];
	for (const r of results) {
		const model = String((r && r.model) || "");
		if (!/^[\w.-]+\/[\w.:-]+$/.test(model) || model.length > 100) continue;
		const tags = [...new Set((Array.isArray(r.tags) ? r.tags : []).map(cleanTag).filter((t) => SKILL_TAG.test(t)))].slice(0, 8);
		for (const tag of tags) rows.push([tag, model, r.ok ? 1 : 0]);
	}
	if (!rows.length) return json({ ok: true, added: 0 });
	const day = new Date().toISOString().slice(0, 10);
	const used = await env.DB.prepare("SELECT n FROM skill_days WHERE user_id = ? AND day = ?").bind(user.id, day).first();
	const room = 600 - ((used && used.n) || 0);
	if (room <= 0) return json({ ok: true, added: 0 });
	const take = rows.slice(0, room), at = now();
	await env.DB.batch([
		...take.map(([tag, model, ok]) => env.DB.prepare("INSERT INTO skill_stats (tag, model, ok, n, at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(tag, model) DO UPDATE SET ok = ok + excluded.ok, n = n + 1, at = excluded.at").bind(tag, model, ok, at)),
		env.DB.prepare("INSERT INTO skill_days (user_id, day, n) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET n = n + excluded.n").bind(user.id, day, take.length),
	]);
	return json({ ok: true, added: take.length });
}
async function skillsGet(env, url) {
	const tags = [...new Set(String(url.searchParams.get("tags") || "").split(",").map(cleanTag).filter((t) => SKILL_TAG.test(t)))].slice(0, 80);
	if (!tags.length) return json({ stats: [] });
	const r = await env.DB.prepare("SELECT tag, model, ok, n FROM skill_stats WHERE tag IN (" + tags.map(() => "?").join(",") + ") AND n >= 3").bind(...tags).all();
	return json({ stats: (r.results || []).map((x) => [x.tag, x.model, x.ok, x.n]) });
}

// ------------------------------------------------------------------ tasks
// Something to do by itself on a schedule (like ChatGPT's tasks): "every weekday at 7, the AI news that matters". Each run
// is an ordinary request made for the person (their credits, the models Andromeda picked for it, a live web search),
// and its answer waits for them in the app.
const EVERY = ["once", "hour", "day", "weekdays", "week"];
function nextRun(t, after) {
	const off = (Number(t.tz) || 0) * 60e3, local = after + off, day = 864e5;
	const m = Math.max(0, Math.min(1439, Number(t.minute) || 0)) * 60e3;
	if (t.every === "hour") {
		const h = 3600e3;
		let n = Math.floor(local / h) * h + (m % h);
		if (n <= local) n += h;
		return n - off;
	}
	let n = Math.floor(local / day) * day + m;
	for (let k = 0; k < 9; k++, n += day) {
		const dow = new Date(n).getUTCDay();
		if (n > local && (t.every === "day" || t.every === "once" || (t.every === "weekdays" && dow >= 1 && dow <= 5) || (t.every === "week" && dow === Number(t.dow)))) return n - off;
	}
	return after + day;
}
const taskOut = (t) => ({ id: t.id, title: t.title, prompt: t.prompt, every: t.every, minute: t.minute, dow: t.dow, tz: t.tz, web: !!t.web, next_at: t.next_at, last_at: t.last_at, active: !!t.active });
async function taskList(env, user) {
	const tasks = (await env.DB.prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC").bind(user.id).all()).results || [];
	const runs = (await env.DB.prepare("SELECT id, task_id, text, error, model, created_at, seen FROM task_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 40").bind(user.id).all()).results || [];
	return json({ tasks: tasks.map(taskOut), runs });
}
async function taskSave(req, env, user) {
	const b = await body(req);
	const prompt = String(b.prompt || "").trim().slice(0, 4000);
	if (!prompt) throw fail(400, "Say what the task should do.");
	const every = EVERY.includes(b.every) ? b.every : "day";
	const [hh, mm] = String(b.time || "08:00").split(":").map(Number);
	const t = {
		title: String(b.title || prompt).replace(/\s+/g, " ").trim().slice(0, 80), prompt, every,
		minute: Math.max(0, Math.min(1439, (hh || 0) * 60 + (mm || 0))), dow: Math.max(0, Math.min(6, Number(b.dow) || 0)),
		tz: Math.max(-840, Math.min(840, Math.round(Number(b.tz) || 0))), web: b.web === false ? 0 : 1,
		models: JSON.stringify((Array.isArray(b.models) ? b.models : []).filter((x) => typeof x === "string" && x.length < 120).slice(0, 4)),
		active: b.active === false ? 0 : 1,
	};
	t.next_at = nextRun(t, now());
	if (/^[a-f0-9]{24}$/.test(String(b.id || ""))) {
		const r = await env.DB.prepare("UPDATE tasks SET title = ?, prompt = ?, every = ?, minute = ?, dow = ?, tz = ?, web = ?, models = ?, active = ?, next_at = ? WHERE id = ? AND user_id = ?")
			.bind(t.title, t.prompt, t.every, t.minute, t.dow, t.tz, t.web, t.models, t.active, t.next_at, b.id, user.id).run();
		if (r.meta && r.meta.changes) return json({ task: taskOut({ ...t, id: b.id }) });
	}
	const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?").bind(user.id).first();
	if (n && n.n >= 20) throw fail(429, "You have 20 tasks already: delete one to add another.");
	const tid = id();
	await env.DB.prepare("INSERT INTO tasks (id, user_id, title, prompt, every, minute, dow, tz, web, models, active, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(tid, user.id, t.title, t.prompt, t.every, t.minute, t.dow, t.tz, t.web, t.models, t.active, t.next_at, now()).run();
	return json({ task: taskOut({ ...t, id: tid }) });
}
async function taskDel(env, user, tid) {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?").bind(tid, user.id),
		env.DB.prepare("DELETE FROM task_runs WHERE task_id = ? AND user_id = ?").bind(tid, user.id),
	]);
	return json({ ok: true });
}
async function taskSeen(req, env, user) {
	const b = await body(req);
	const ids = (Array.isArray(b.ids) ? b.ids : []).filter((x) => /^[a-f0-9]{24}$/.test(String(x))).slice(0, 100);
	if (ids.length) await env.DB.batch(ids.map((x) => env.DB.prepare("UPDATE task_runs SET seen = 1 WHERE id = ? AND user_id = ?").bind(x, user.id)));
	return json({ ok: true });
}
async function taskRunNow(env, ctx, user, tid) {
	const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?").bind(tid, user.id).first();
	if (!t) throw fail(404, "That task doesn't exist.");
	const r = await runTask(env, ctx, t);
	return json({ run: r });
}
// one run: the request as the person would send it, the models tried in the order Andromeda picked them
async function runTask(env, ctx, t) {
	const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(t.user_id).first();
	if (!user) return null;
	let models = [];
	try { models = JSON.parse(t.models || "[]"); } catch {}
	if (!models.length) models = ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol", "google/gemini-3.8-flash"];
	const when = new Date(now() + (Number(t.tz) || 0) * 60e3).toISOString().slice(0, 16).replace("T", " ");
	const messages = [
		{ role: "system", content: "You are Andromeda. This is a task the user set up to run by itself on a schedule, and it's running now: " + when + " in their time. Do it completely, as a finished message to them: what matters first, no preamble, and no questions back (they aren't here to answer). Use Markdown." },
		{ role: "user", content: t.prompt },
	];
	let text = "", error = "", used = "";
	for (const model of models) {
		try {
			const res = await chat(new Request("https://andromeda.internal/api/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages, ...(t.web ? { plugins: [{ id: "web", max_results: 6, query: t.prompt.slice(0, 300) }] } : {}) }) }), env, ctx, user);
			const j = await res.json().catch(() => ({}));
			text = String(j.choices?.[0]?.message?.content || "");
			if (text) { used = model; break; }
			error = j.error?.message || "No answer came back.";
		} catch (e) {
			error = e.message || String(e);
			if (e.status === 402) break;
		}
	}
	const rid = id(), at = now();
	await env.DB.prepare("INSERT INTO task_runs (id, task_id, user_id, text, error, model, created_at, seen) VALUES (?, ?, ?, ?, ?, ?, ?, 0)").bind(rid, t.id, t.user_id, text || null, text ? null : error, used || null, at).run();
	return { id: rid, task_id: t.id, text, error: text ? "" : error, model: used, created_at: at };
}
async function runDueTasks(env, ctx) {
	const due = (await env.DB.prepare("SELECT * FROM tasks WHERE active = 1 AND next_at <= ? ORDER BY next_at LIMIT 25").bind(now()).all()).results || [];
	for (const t of due) {
		// moved on before it runs, so a slow or failing run never runs twice
		const next = t.every === "once" ? 0 : nextRun(t, now());
		await env.DB.prepare("UPDATE tasks SET last_at = ?, next_at = ?, active = ? WHERE id = ?").bind(now(), next || t.next_at, next ? 1 : 0, t.id).run();
		try { await runTask(env, ctx, t); } catch {}
	}
}

// ------------------------------------------------------------------ payments

async function qrisPayment(req, env, user) {
	const c = await config(env);
	if (!c.open) throw fail(403, "Credits aren't on sale yet.");
	const b = await body(req);
	const pack = c.packs.find((p) => p.id === b.pack);
	if (!pack || !pack.prices.IDR) throw fail(400, "Pick a pack.");
	const reference = String(b.reference || "").trim().slice(0, 120);
	if (reference.length < 2) throw fail(400, "Write the name on your payment so it can be matched.");
	const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND status = 'pending'").bind(user.id).first();
	if (open && open.n >= 3) throw fail(429, "You already have payments waiting to be confirmed.");
	const pay = { id: id(), user_id: user.id, method: "qris", pack: pack.id, amount: pack.prices.IDR, currency: "IDR", credits_mc: (pack.credits + (pack.bonus || 0)) * 1000, status: "pending", note: reference };
	await env.DB.prepare("INSERT INTO payments (id, user_id, method, pack, amount, currency, credits_mc, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(pay.id, pay.user_id, pay.method, pay.pack, pay.amount, pay.currency, pay.credits_mc, pay.status, pay.note, now()).run();
	return json({ ok: true, payment: { ...pay, credits: pay.credits_mc / 1000 } });
}

async function addCredits(env, paymentId) {
	const p = await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(paymentId).first();
	if (!p) return false;
	const ok = await env.DB.prepare("UPDATE payments SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending'").bind(now(), paymentId).run();
	if (!ok.meta || !ok.meta.changes) return false;
	await env.DB.prepare("UPDATE users SET balance_mc = balance_mc + ? WHERE id = ?").bind(p.credits_mc, p.user_id).run();
	return true;
}

// Lemon Squeezy calls this when an order is paid. Signed with the webhook's signing secret.
async function lemonWebhook(req, env) {
	const raw = await req.text();
	if (!env.LEMON_SECRET) throw fail(503, "Card payments aren't set up.");
	const key = await crypto.subtle.importKey("raw", enc.encode(env.LEMON_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
	if (!sameString(mac, req.headers.get("X-Signature") || "")) throw fail(401, "Bad signature.");
	const ev = JSON.parse(raw);
	if (ev.meta?.event_name !== "order_created") return json({ ok: true, ignored: true });
	const a = ev.data?.attributes || {};
	if (a.status !== "paid") return json({ ok: true, ignored: true });
	const userId = ev.meta?.custom_data?.user_id;
	const user = userId && (await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first());
	if (!user) throw fail(400, "Order has no Andromeda account attached.");
	const ref = "lemon:" + ev.data.id;
	if (await env.DB.prepare("SELECT id FROM payments WHERE ref = ?").bind(ref).first()) return json({ ok: true, duplicate: true });
	const c = await config(env);
	const variant = String(a.first_order_item?.variant_id || "");
	const pack = c.packs.find((p) => p.lemonVariant && String(p.lemonVariant) === variant);
	const credits = pack ? pack.credits + (pack.bonus || 0) : Math.floor(((Number(a.total_usd) || 0) / 100) / c.creditUsd);
	const pid = id();
	await env.DB.prepare("INSERT INTO payments (id, user_id, method, pack, amount, currency, credits_mc, status, ref, created_at) VALUES (?, ?, 'card', ?, ?, ?, ?, 'pending', ?, ?)")
		.bind(pid, user.id, pack ? pack.id : null, (Number(a.total) || 0) / 100, a.currency || "USD", credits * 1000, ref, now()).run();
	await addCredits(env, pid);
	return json({ ok: true });
}

// ------------------------------------------------------------------ admin (the owner, with ADMIN_TOKEN)

async function admin(req, env, p, m) {
	if (!env.ADMIN_TOKEN || !sameString(req.headers.get("X-Admin-Token") || "", env.ADMIN_TOKEN)) throw fail(401, "Wrong admin password.");
	if (p === "/api/admin/overview" && m === "GET") {
		const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).all().then((r) => r.results || []);
		const [pending, recent, users, totals, spent] = await Promise.all([
			q("SELECT p.*, u.email FROM payments p JOIN users u ON u.id = p.user_id WHERE p.status = 'pending' ORDER BY p.created_at"),
			q("SELECT p.*, u.email FROM payments p JOIN users u ON u.id = p.user_id WHERE p.status != 'pending' ORDER BY p.decided_at DESC LIMIT 30"),
			q("SELECT id, email, balance_mc, free_mc, created_at FROM users ORDER BY created_at DESC LIMIT 100"),
			q("SELECT currency, SUM(amount) AS amount, SUM(credits_mc) AS credits_mc, COUNT(*) AS n FROM payments WHERE status = 'approved' GROUP BY currency"),
			q("SELECT SUM(cost_usd) AS cost, SUM(charged_mc) AS charged_mc, COUNT(*) AS n FROM usage"),
		]);
		return json({ pending, recent, users, totals, spent: spent[0] || {}, config: await config(env) });
	}
	const approve = p.match(/^\/api\/admin\/payments\/([\w-]+)\/(approve|reject)$/);
	if (approve && m === "POST") {
		if (approve[2] === "approve") return json({ ok: await addCredits(env, approve[1]) });
		const r = await env.DB.prepare("UPDATE payments SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'").bind(now(), approve[1]).run();
		return json({ ok: !!(r.meta && r.meta.changes) });
	}
	if (p === "/api/admin/credits" && m === "POST") {
		const b = await body(req);
		const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(cleanEmail(b.email)).first();
		if (!u) throw fail(404, "No account with that email.");
		const mc = Math.round(Number(b.credits) * 1000);
		if (!Number.isFinite(mc) || !mc) throw fail(400, "How many credits?");
		const pid = id();
		await env.DB.prepare("INSERT INTO payments (id, user_id, method, amount, currency, credits_mc, status, note, created_at) VALUES (?, ?, 'manual', 0, 'USD', ?, 'pending', ?, ?)").bind(pid, u.id, mc, String(b.note || "").slice(0, 200), now()).run();
		await addCredits(env, pid);
		return json({ ok: true });
	}
	if (p === "/api/admin/config") {
		if (m === "GET") return json(await config(env));
		if (m === "PUT") {
			const b = await body(req);
			if (!b || !Array.isArray(b.packs)) throw fail(400, "The settings need a list of packs.");
			await env.DB.prepare("INSERT INTO config (k, v) VALUES ('pricing', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(b)).run();
			return json({ ok: true, config: await config(env) });
		}
	}
	throw fail(404, "Not found");
}
