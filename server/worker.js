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
	multipliers: { cheap: 3.5, mid: 2.5, top: 2 },
	bands: { cheapBelow: 2, topFrom: 15 },
	// the most one answer may write, whatever the balance
	maxTokens: 8192,
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
	return { ...DEFAULT_CONFIG, ...saved, multipliers: { ...DEFAULT_CONFIG.multipliers, ...(saved.multipliers || {}) }, bands: { ...DEFAULT_CONFIG.bands, ...(saved.bands || {}) } };
}
function publicConfig(c) {
	return { creditUsd: c.creditUsd, packs: c.packs.map(({ lemonVariant, ...p }) => p), currencies: c.currencies, qris: c.qris, checkout: c.checkout, support: c.support, open: !!c.open };
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
	await env.DB.prepare("INSERT INTO users (id, email, pass, balance_mc, created_at) VALUES (?, ?, ?, 0, ?)").bind(user.id, email, await hashPassword(password, env), now()).run();
	const token = await newSession(env, user.id);
	return json({ token, me: await meOf(env, { ...user, balance_mc: 0 }) });
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
	return row;
}
async function meOf(env, user) {
	const fresh = await env.DB.prepare("SELECT balance_mc FROM users WHERE id = ?").bind(user.id).first();
	const pays = await env.DB.prepare("SELECT id, method, pack, amount, currency, credits_mc, status, created_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 10").bind(user.id).all();
	return {
		id: user.id,
		email: user.email,
		credits: (fresh ? fresh.balance_mc : user.balance_mc) / 1000,
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
	if (user.balance_mc < 1000) throw fail(402, "You're out of credits. Buy credits to keep going.");

	const mult = multiplier(price, c);
	// credits -> what the request may spend at OpenRouter
	const toUsd = (mc) => (mc / 1000) * c.creditUsd / mult;
	// a hair under, so floating-point dust (1.0000000000000002) never rounds a whole extra unit up
	const toMc = (usd) => Math.ceil((usd * mult / c.creditUsd) * 1000 - 1e-6);
	const inTokens = Math.ceil(JSON.stringify(b.messages || []).length / 3);
	const inUsd = inTokens * price.pin;
	const room = toUsd(user.balance_mc) - inUsd;
	if (room <= 0) throw fail(402, "Not enough credits for a message this long. Buy credits or start a new chat.");
	let maxOut = Math.min(Number(b.max_tokens) || c.maxTokens, c.maxTokens);
	if (price.pout > 0) maxOut = Math.min(maxOut, Math.floor(room / price.pout));
	if (maxOut < 64) throw fail(402, "Not enough credits for this model. Buy credits or choose a lower Quality.");

	// reserve the worst case first; only one statement can win, so parallel requests can't overspend
	const reserve = toMc(inUsd + maxOut * price.pout);
	const held = await env.DB.prepare("UPDATE users SET balance_mc = balance_mc - ? WHERE id = ? AND balance_mc >= ?").bind(reserve, user.id, reserve).run();
	if (!held.meta || !held.meta.changes) throw fail(402, "Not enough credits right now. Wait for your other answers to finish, or buy credits.");

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
			env.DB.prepare("UPDATE users SET balance_mc = balance_mc + ? WHERE id = ?").bind(reserve - charged, user.id),
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
			q("SELECT id, email, balance_mc, created_at FROM users ORDER BY created_at DESC LIMIT 100"),
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
