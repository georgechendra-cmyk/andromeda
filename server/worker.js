// Andromeda credits server.
//
// Holds the owner's OpenRouter key (a secret, never sent to a browser), keeps each user's credit balance, and charges
// every request. Money only ever moves one way: a user pays first, credits appear, usage spends them. A request can
// never spend more than the user has, because its worst-case cost is reserved before it is sent and the unused part is
// refunded when the real cost comes back.
//
// 1 credit = creditUsd (default $0.01) of usage at Andromeda's prices. Andromeda's price is OpenRouter's real cost
// times a multiplier that depends on how expensive the model is (cheap models carry a bigger multiple, top models a
// smaller one, so a big build never feels expensive). Everything is set from the admin page, nothing is hard-coded.

const DEFAULT_CONFIG = {
	creditUsd: 0.01,
	// OpenRouter cost x this. Bands are by the model's output price in dollars per million tokens.
	multipliers: { cheap: 3.5, mid: 2.5, top: 2, media: 2 },
	bands: { cheapBelow: 2, topFrom: 15 },
	// the most one answer may write, whatever the balance
	maxTokens: 8192,
	// free credits for everyone signed in: a session's worth (about Rp5,000 at Starter prices), spent before anything
	// paid for, full again "hours" after the first one is used
	free: { credits: 32, hours: 24 },
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
};

async function route(req, env, ctx, url) {
	const p = url.pathname.replace(/\/+$/, "");
	const m = req.method;
	if (p === "/api/pricing" && m === "GET") return json(publicConfig(await config(env)));
	if (p === "/api/signup" && m === "POST") return signup(req, env);
	if (p === "/api/login" && m === "POST") return login(req, env);
	if (p === "/api/webhooks/lemonsqueezy" && m === "POST") return lemonWebhook(req, env);
	if (p.startsWith("/api/admin/")) return admin(req, env, p, m);

	const user = await authUser(req, env);
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
	if (p === "/api/tools/docs" && m === "POST") return toolDocs(req, env);
	if (p === "/api/tools/fetch" && m === "POST") return toolFetch(req, env);
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
	const ok = !allowed.length || allowed.includes(origin) || allowed.includes("*");
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
	return { ...DEFAULT_CONFIG, ...saved, multipliers: { ...DEFAULT_CONFIG.multipliers, ...(saved.multipliers || {}) }, bands: { ...DEFAULT_CONFIG.bands, ...(saved.bands || {}) }, free: { ...DEFAULT_CONFIG.free, ...(saved.free || {}) } };
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
	const full = Math.round((Number((await config(env)).free.credits) || 0) * 1000);
	await env.DB.prepare("INSERT INTO users (id, email, pass, balance_mc, free_mc, free_reset_at, created_at) VALUES (?, ?, ?, 0, ?, 0, ?)").bind(user.id, email, await hashPassword(password, env), full, now()).run();
	const token = await newSession(env, user.id);
	return json({ token, me: await meOf(env, { ...user, balance_mc: 0, free_mc: full, free_reset_at: 0 }) });
}
async function login(req, env) {
	const b = await body(req);
	const email = cleanEmail(b.email);
	const u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
	if (!u || !(await checkPassword(String(b.password || ""), u.pass, env))) throw fail(401, "Wrong email or password.");
	const token = await newSession(env, u.id);
	return json({ token, me: await meOf(env, u) });
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
async function refill(env, user, c) {
	const full = Math.round((Number(c.free.credits) || 0) * 1000);
	if (user.free_reset_at && now() >= user.free_reset_at) {
		await env.DB.prepare("UPDATE users SET free_mc = ?, free_reset_at = 0 WHERE id = ? AND free_reset_at = ?").bind(full, user.id, user.free_reset_at).run();
		user.free_mc = full;
		user.free_reset_at = 0;
	} else if (!user.free_reset_at && (user.free_mc || 0) < full) {
		// a full bucket that's never been touched since the amount went up (or an account from before free credits)
		await env.DB.prepare("UPDATE users SET free_mc = ? WHERE id = ? AND free_reset_at = 0").bind(full, user.id).run();
		user.free_mc = full;
	}
	return user;
}
const spendable = (u) => Math.max(0, u.free_mc || 0) + Math.max(0, u.balance_mc || 0);
function outOfCredits(u, c) {
	const left = u.free_reset_at ? Math.max(0, u.free_reset_at - now()) : 0;
	const mins = Math.max(1, Math.ceil(left / 60e3)), h = Math.floor(mins / 60), m = mins % 60;
	return fail(402, left && Number(c.free.credits) > 0
		? "You've used your free credits for now. " + c.free.credits + " more come back in " + (h ? h + "h" + (m ? " " + m + "m" : "") : m + "m") + ", or buy credits to keep going."
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
	for (const m of j.data || []) map.set(m.id, { pin: Number(m.pricing?.prompt || 0), pout: Number(m.pricing?.completion || 0) });
	if (map.size) PRICES = { at: Date.now(), map };
	return map;
}
const orBase = (env) => (env.OPENROUTER_BASE || "https://openrouter.ai/api/v1").replace(/\/$/, "");
function multiplier(price, c) {
	const perM = price.pout * 1e6;
	return perM < c.bands.cheapBelow ? c.multipliers.cheap : perM >= c.bands.topFrom ? c.multipliers.top : c.multipliers.mid;
}

async function chat(req, env, ctx, user) {
	const c = await config(env);
	const b = await body(req);
	if (typeof b.model !== "string" || b.model.startsWith("openrouter/")) throw fail(400, "Pick a specific model.");
	const price = (await prices(env)).get(b.model);
	if (!price) throw fail(400, "That model isn't available.");
	if (spendable(user) < 1000) throw outOfCredits(user, c);

	const mult = multiplier(price, c);
	// credits -> what the request may spend at OpenRouter
	const toUsd = (mc) => (mc / 1000) * c.creditUsd / mult;
	// a hair under, so floating-point dust (1.0000000000000002) never rounds a whole extra unit up
	const toMc = (usd) => Math.ceil((usd * mult / c.creditUsd) * 1000 - 1e-6);
	const inTokens = Math.ceil((JSON.stringify(b.messages || []).length + (b.tools ? JSON.stringify(b.tools).length : 0)) / 3);
	// web search is the only plugin: a few results, each paid at OpenRouter's search price
	const web = (Array.isArray(b.plugins) ? b.plugins : []).find((x) => x && x.id === "web");
	if (web) b.plugins = [{ id: "web", max_results: Math.max(1, Math.min(8, Number(web.max_results) || 5)) }];
	else delete b.plugins;
	const inUsd = inTokens * price.pin + (web ? b.plugins[0].max_results * 0.004 : 0);
	const room = toUsd(spendable(user)) - inUsd;
	if (room <= 0) throw fail(402, "Not enough credits for a message this long. Buy credits or start a new chat.");
	let maxOut = Math.min(Number(b.max_tokens) || c.maxTokens, c.maxTokens);
	if (price.pout > 0) maxOut = Math.min(maxOut, Math.floor(room / price.pout));
	if (maxOut < 64) throw fail(402, "Not enough credits for this model. Buy credits or choose a lower Quality.");

	// reserve the worst case first; only one statement can win, so parallel requests can't overspend
	const reserve = toMc(inUsd + maxOut * price.pout);
	const held = await take(env, user.id, reserve, c);
	if (!held) throw outOfCredits(user, c);

	let settled = false;
	const settle = async (usage, outChars) => {
		if (settled) return null;
		settled = true;
		let usd = Number(usage && usage.cost);
		if (!Number.isFinite(usd)) {
			const ti = (usage && usage.prompt_tokens) || inTokens;
			const to = (usage && usage.completion_tokens) || Math.ceil((outChars || 0) / 4);
			usd = ti * price.pin + to * price.pout;
		}
		// the real cost, even past the reserve (the input estimate can run low, e.g. images): the owner never absorbs it.
		// The output was capped to what the balance covers, so any overshoot is small, and a balance below zero only
		// blocks the next request until credits are bought.
		const charged = toMc(usd);
		await env.DB.batch([
			giveBack(env, user.id, held, charged),
			env.DB.prepare("INSERT INTO usage (user_id, model, cost_usd, charged_mc, created_at) VALUES (?, ?, ?, ?, ?)").bind(user.id, b.model, usd, charged, now()),
		]);
		return charged;
	};

	const upstream = { ...b, max_tokens: maxOut, usage: { include: true }, user: user.id };
	let r;
	try {
		r = await fetch(orBase(env) + "/chat/completions", {
			method: "POST",
			headers: { Authorization: "Bearer " + env.OPENROUTER_KEY, "Content-Type": "application/json", "HTTP-Referer": env.SITE_URL || "https://andromeda.app", "X-Title": "Andromeda" },
			body: JSON.stringify(upstream),
		});
	} catch (e) {
		await settle({ cost: 0 }, 0);
		throw fail(502, "Couldn't reach the AI provider. Try again.");
	}
	if (!r.ok) {
		await settle({ cost: 0 }, 0);
		let msg = r.statusText;
		try { msg = (await r.json()).error?.message || msg; } catch {}
		return json({ error: { message: msg, code: r.status } }, r.status);
	}
	// what the user is shown is what they were charged, in credit-dollars
	const shown = (usage, mc) => ({ ...usage, cost: (mc / 1000) * c.creditUsd, credits: mc / 1000 });

	if (!b.stream) {
		const j = await r.json();
		const mc = await settle(j.usage, (j.choices?.[0]?.message?.content || "").length);
		if (j.usage) j.usage = shown(j.usage, mc);
		return json(j);
	}

	const { readable, writable } = new TransformStream();
	ctx.waitUntil((async () => {
		const reader = r.body.getReader();
		const writer = writable.getWriter();
		let buf = "", outChars = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let out = "", i;
				while ((i = buf.indexOf("\n")) >= 0) {
					let line = buf.slice(0, i);
					buf = buf.slice(i + 1);
					const t = line.trim();
					if (t.startsWith("data:") && t.slice(5).trim() !== "[DONE]") {
						try {
							const j = JSON.parse(t.slice(5));
							outChars += (j.choices?.[0]?.delta?.content || "").length;
							if (j.usage) {
								const mc = await settle(j.usage, outChars);
								if (mc != null) j.usage = shown(j.usage, mc);
								line = "data: " + JSON.stringify(j);
							}
						} catch {}
					}
					out += line + "\n";
				}
				if (out) await writer.write(enc.encode(out));
			}
			if (buf) await writer.write(enc.encode(buf));
		} catch {
			try { await reader.cancel(); } catch {}
		} finally {
			await settle(null, outChars);
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
	const c = await config(env), mt = media(c);
	const b = await body(req);
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
	const r = await fetch(orBase(env) + "/videos/" + jobId + "/content?index=" + index, { headers: { Authorization: "Bearer " + env.OPENROUTER_KEY } });
	if (!r.ok) throw fail(r.status === 404 ? 404 : 502, "That video isn't ready or has expired.");
	return new Response(r.body, { headers: { "Content-Type": r.headers.get("Content-Type") || "video/mp4", "Cache-Control": "private, max-age=3600" } });
}

async function imageGen(req, env, user) {
	const c = await config(env), mt = media(c);
	const b = await body(req);
	if (typeof b.model !== "string") throw fail(400, "Pick an image model.");
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
	const c = await config(env), mt = media(c);
	const b = await body(req);
	const text = Array.isArray(b.input) ? b.input.map((x) => x.text || "").join(" ") : String(b.input || "");
	if (!text.trim() || text.length > 10000) throw fail(400, "Give the voice between 1 and 10,000 characters.");
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
