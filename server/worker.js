// Celestin credits server.
//
// Holds the owner's AI keys (secrets, never sent to a browser), keeps each user's credit balance, and charges every
// request. Models are reached through Cloudflare AI Gateway's Unified Billing (OpenAI, Anthropic, Google, xAI) or
// OpenRouter (see "the ways to a model"), each at the thinking effort it scored best at. Money only
// ever moves one way: a user pays first, credits appear, usage spends them. A request can never spend more than the
// user has, because its worst-case cost is reserved before it is sent and the unused part is refunded when the real
// cost comes back.
//
// 1 credit = creditUsd (default $0.01) of usage at Celestin's prices. Celestin's price is the model's list price
// times a multiplier that depends on how expensive the model is (cheap models carry a bigger multiple, top models a
// smaller one, so a big build never feels expensive). Prices, plans, free credits and how the shop runs are all set here
// in the code: the owner asks for changes, and there's no admin page (payments by QRIS are approved with owner.mjs).

const DEFAULT_CONFIG = {
	creditUsd: 0.01,
	// films animated in code (Claude writes every frame): "owner" = only on the owner's account (the owner, Nov 6: to test
	// it), true = for everyone, false = off
	drawn: "owner",
	// the order the gateways are asked in, by number (GATEWAY_URL is 1, GATEWAY2_URL is 2). The owner's demo tries MarkasAI
	// first, with Flaz behind it. A gateway that's busy or out of balance hands the request on
	gatewayOrder: ["1", "2"],
	ownerGatewayOrder: ["2", "1"],
	// the gateways everyone else may use at all (the owner, Nov 7: "MarkasAI is only for the demo": the public site never
	// reaches it, not even as a backup, and isn't shown the models only it has; "ws" is WaveSpeed, when it's set up)
	publicGateways: ["1", "ws"],
	// deep work on one gateway only, never handed on ("" = any). Off (the owner, Nov 7: when MarkasAI is busy, deep work
	// mustn't wait on it; it goes where everything else goes)
	deepGateway: "",
	// the model's list price x this. 3x is about where profit peaks for a new AI app with free rivals: a 10% higher price
	// loses some 15-20% of buyers, so profit is nearly flat from 2.5x to 4x and falls past it. Bands are by the model's
	// output price in dollars per million tokens.
	// (media at 3x too: a plan's worst case assumes no credit costs the owner more than a chat credit does)
	multipliers: { cheap: 3, mid: 3, top: 3, media: 3 },
	bands: { cheapBelow: 2, topFrom: 15 },
	// the most one answer may write, whatever the balance (a model asked to think gets room for that on top); only what's
	// written is charged, so this only keeps a long answer from being cut off
	maxTokens: 32000,
	// Everyone is on a plan: Free, or one bought for a month. Free is a window of credits that all comes back "hours" after
	// it's first used (Claude's 5-hour limit), at most "week" credits in 7 days, inside a daily budget for all free use
	// together (budgetIdr: the most the owner spends on free use a day, at its real cost in rupiah at usdIdr; past it, no
	// free window refills until tomorrow). Free's "every" can hand the window back in shares instead (every 0 or = hours:
	// all at once). dailyCap: an older limit on credits handed out (0 = off).
	// A free account costs the owner at most "week" x Rp69 a week (about Rp10,000), and all of them together never more
	// than budgetIdr a day. 150 credits a week is about 50 everyday answers, 20 changes to code, or an app by the best
	// builder (the window holds one at its medium effort, about 100).
	// (budgetIdr 3,000 since Nov 7: the owner's gateway money is a weekly allowance until sales come in, so free use is held to
	// about Rp21,000 a week for everyone together; raise it once plans sell)
	free: { credits: 100, hours: 5, every: 5, week: 150, budgetIdr: 3000, usdIdr: 18000, dailyCap: 0 },
	// A plan, bought for a month (30 days; QRIS confirmed by hand, cards automatic). Each month of it gives that plan's month
	// of credits ("month"), used at most "credits" in any "hours" (Claude's 5-hour limit). Nothing piles up: the window and
	// the month each start again full, never more, and what wasn't used is gone. Paying early adds 30 days to the end, with
	// their credits when that month begins (planChange). Ran out before the month is over? A credit pack keeps them going.
	// The owner's rule (Nov 2): at least twice what it costs on every plan even when someone uses every last credit, the
	// most on the $20 plan and less the dearer the plan, so the bigger plans are the better deal. A credit costs the owner
	// at most Rp69 (the labs' list price, the gateway's 15%, at Rp18,000 a dollar), so a payment's worst case is "month" x
	// Rp69, and the price is 2.2x, 2.1x and 2x that. Each paid month brings at most one month of credits (a switch to another
	// plan turns what was left into days of the new one at its price), so no timing of renewals, upgrades or bursts can cost
	// more. Packs (the only thing sold since Nov 7) sell a credit at 2.2x down to 2.0x, and never expire.
	// Nonstop coding is about 60 credits an hour (CODE_HOUR in the site, measured Nov 4 with the owner's price rule; it was
	// 140 before): every plan codes nonstop in any 5 hours; Nova about 35 hours a month, Pulsar about 183, Quasar about 386.
	// (no subscriptions: the owner, Nov 7, "remove subscriptions, just do the packs". The plans as they were are kept in
	// retiredPlans; moving them back into plans puts them on sale again)
	plans: [],
	retiredPlans: [
		{ id: "nova", name: "Nova", credits: 420, hours: 5, week: 0, month: 2100, days: 30, prices: { USD: 20, IDR: 319000, EUR: 19, GBP: 16, SGD: 27, AUD: 30 }, lemonVariant: "" },
		{ id: "pulsar", name: "Pulsar", credits: 900, hours: 5, week: 0, month: 11000, days: 30, popular: true, prices: { USD: 100, IDR: 1599000, EUR: 93, GBP: 79, SGD: 135, AUD: 152 }, lemonVariant: "" },
		{ id: "quasar", name: "Quasar", credits: 1000, hours: 5, week: 0, month: 23150, days: 30, prices: { USD: 200, IDR: 3199000, EUR: 186, GBP: 158, SGD: 270, AUD: 304 }, lemonVariant: "" },
	],
	// credit packs: bought credits that never expire, used once the plan's window or week runs out, so there's no waiting.
	// Round local prices, not exchange-rate conversions; a credit costs more this way than in a plan
	packs: [
		// (the owner, Nov 7: Comet the cheapest, up into the millions; about 2.2x the owner's cost down to 2.0x, a credit
		// costing the owner about Rp69, so a bigger pack is a better deal and none is under 2x)
		{ id: "plus", name: "Comet", credits: 1040, bonus: 0, prices: { USD: 10, IDR: 159000, EUR: 10, GBP: 8, SGD: 13, AUD: 15 }, lemonVariant: "" },
		{ id: "pro", name: "Meteor", credits: 2150, bonus: 0, prices: { USD: 20, IDR: 319000, EUR: 19, GBP: 16, SGD: 27, AUD: 30 }, lemonVariant: "" },
		{ id: "nebula", name: "Nebula", credits: 5500, bonus: 0, prices: { USD: 50, IDR: 799000, EUR: 47, GBP: 40, SGD: 68, AUD: 76 }, lemonVariant: "" },
		{ id: "supernova", name: "Supernova", credits: 11300, bonus: 0, prices: { USD: 100, IDR: 1599000, EUR: 93, GBP: 79, SGD: 135, AUD: 152 }, lemonVariant: "" },
		{ id: "galaxy", name: "Galaxy", credits: 23150, bonus: 0, prices: { USD: 200, IDR: 3199000, EUR: 186, GBP: 158, SGD: 270, AUD: 304 }, lemonVariant: "" },
	],
	currencies: ["USD", "IDR", "EUR", "GBP", "SGD", "AUD"],
	// How the shop runs (no admin page: changed here). QRIS for rupiah: the owner's QR image (a URL, e.g. qris.png in the
	// site) and the name it shows
	qris: { image: "", name: "" },
	// card / Apple Pay / PayPal for everyone else: a checkout page per plan ("plan:<id>") and per pack (Lemon Squeezy),
	// and each one's variant id, which is how a paid order is matched to what was bought
	checkout: { provider: "Lemon Squeezy", links: {}, variants: {} },
	// how to reach the owner, shown in the shop's questions
	support: "celestinsupportai@gmail.com",
	// plans and packs on sale
	open: false,
	// Changed your mind: within "days" of paying, with less than "usedShare" of what was bought used, the money back
	// (the plan or credits end when it's asked for)
	refund: { days: 7, usedShare: 0.2 },
};

// The owner's own account: no limits at all (what it uses is still counted), but only on the owner's own computer (the
// owner key, below). Named by its account id, never its email: a password account's email isn't checked, so an email
// alone would let anyone who signs up with it in.
const OWNER_IDS = new Set(["36c872cb39f4da74877b3207"]);
const isOwner = (userId) => OWNER_IDS.has(String(userId || ""));
// the most the owner's own use may really cost in 24 hours (about one full app build, or a hundred everyday answers)
const OWNER_DAY_IDR = 0; // (0: no limit, the owner's choice)
// Unlimited only with the owner key too (the OWNER_KEY secret, sent as X-Owner-Key): it's kept only in the browser of the
// owner's own computer, put there by the demo shortcut that lives on it. Someone who got into the owner's account any
// other way (a stolen password, a stolen sign-in) gets the normal limits, so it can't run up the owner's bill. (No
// OWNER_KEY set: nobody is unlimited.)
const ownerKeyOk = (req, env) => !!(req && env && env.OWNER_KEY && String(env.OWNER_KEY).trim().length >= 32 && sameString(String(req.headers.get("X-Owner-Key") || "").trim(), String(env.OWNER_KEY).trim()));
const ownerHere = (req, env, userId) => isOwner(userId) && ownerKeyOk(req, env);

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
	// every few minutes: the scheduled tasks that are due run (see "tasks"), and pictures shared with apps a day ago go
	async scheduled(event, env, ctx) {
		ctx.waitUntil(runDueTasks(env, ctx));
		ctx.waitUntil(columns(env).then(() => env.DB.batch([env.DB.prepare("DELETE FROM uploads WHERE created_at < ?").bind(now() - UPLOAD_LIFE), env.DB.prepare("DELETE FROM email_codes WHERE expires_at < ?").bind(now() - 86400e3)])).catch(() => {}));
	},
};

async function route(req, env, ctx, url) {
	const p = url.pathname.replace(/\/+$/, "");
	const m = req.method;
	await columns(env);
	if (p === "/api/pricing" && m === "GET") {
		const c0 = await config(env);
		// (the public is shown only what its gateways reach; the demo, with the owner key, everything)
		return json({ ...publicConfig(c0), reach: await reachOf(env, ownerKeyOk(req, env) ? undefined : c0.publicGateways), google: env.GOOGLE_CLIENT_ID || "", emailCodes: mailOn(env), cantFinish: await cantFinishList(env), down: await downList(env), speed: await speedList(env) });
	}
	if (p === "/api/signup" && m === "POST") return signup(req, env);
	if (p === "/api/login/verify" && m === "POST") return loginVerify(req, env);
	if (p === "/api/login/resend" && m === "POST") return loginResend(req, env);
	if (p === "/api/password/forgot" && m === "POST") return passwordForgot(req, env);
	if (p === "/api/password/reset" && m === "POST") return passwordReset(req, env);
	if (p === "/api/support" && m === "POST") return supportNew(req, env);
	if (p === "/api/login" && m === "POST") return login(req, env);
	if (p === "/api/auth/google" && m === "POST") return googleSignIn(req, env);
	if (p === "/api/webhooks/lemonsqueezy" && m === "POST") return lemonWebhook(req, env);
	if (p === "/api/media/models" && m === "GET") return json(wsOn(env) ? await wsCatalog(env) : gwMediaCatalog(await gwMedia(env, ownerKeyOk(req, env) ? undefined : (await config(env)).publicGateways)));
	// a shared chat: anyone with its link can read it; a picture shared with an app, anyone with its link can fetch
	let sh, up;
	if ((sh = p.match(/^\/api\/shares\/([a-f0-9]{24})$/)) && m === "GET") return shareGet(env, sh[1]);
	if ((up = p.match(/^\/api\/uploads\/([a-f0-9]{96})(?:\.(?:png|jpg|webp|gif))?$/)) && m === "GET") return uploadGet(env, up[1]);

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
	if (p === "/api/me" && m === "DELETE") return deleteMe(env, user);
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
	if (p === "/api/support" && m === "GET") return supportList(env, user);
	let tkt;
	if ((tkt = p.match(/^\/api\/support\/(\d{6})\/solved$/)) && m === "POST") return supportSolved(env, user, tkt[1]);
	if (p === "/api/refunds" && m === "POST") return refundAsk(req, env, user);
	if (p === "/api/uploads" && m === "POST") return uploadPut(req, env, user, url);
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
		"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type, HTTP-Referer, X-Title, X-Owner-Key",
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

// Everything, prices and the shop alike, comes from the code (a "pricing" row an old admin page saved is no longer read)
let CONFIG = null;
async function config() {
	if (CONFIG) return CONFIG;
	const ck = DEFAULT_CONFIG.checkout, variants = ck.variants || {};
	const vary = (list, pre) => list.map((p) => ({ ...p, lemonVariant: String(variants[pre + p.id] || p.lemonVariant || "") }));
	return (CONFIG = { ...DEFAULT_CONFIG, checkout: { ...ck, links: { ...(ck.links || {}) }, variants: { ...variants } }, plans: vary(DEFAULT_CONFIG.plans, "plan:"), packs: vary(DEFAULT_CONFIG.packs, "") });
}
function publicConfig(c) {
	const { every, share } = freeStep(c);
	return { creditUsd: c.creditUsd, media: Number(c.multipliers.media) || 2, chat: Number(c.multipliers.top) || 3, free: { credits: Number(c.free.credits) || 0, hours: Number(c.free.hours) || 24, every, share, week: Number(c.free.week) || 0 }, plans: c.plans.map(({ lemonVariant, ...p }) => p), packs: c.packs.map(({ lemonVariant, ...p }) => p), currencies: c.currencies, qris: c.qris, checkout: { provider: c.checkout.provider, links: c.checkout.links }, support: c.support, open: !!c.open, refund: c.refund, drawn: c.drawn === true ? true : c.drawn === "owner" ? "owner" : false };
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
// ---- sign-in codes by email (through the owner's Gmail: a Google Apps Script web app that sends what it's given). A
// password alone doesn't sign in once mail is set up: the 6-digit code sent to the account's email is asked for too
const mailOn = (env) => !!(env.MAIL_URL && env.MAIL_KEY);
async function sendMail(env, to, subject, text, html) {
	let j = null;
	try {
		const r = await fetch(String(env.MAIL_URL).trim(), { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ key: String(env.MAIL_KEY).trim(), to, subject, text, html }), redirect: "follow" });
		j = await r.json().catch(() => null);
	} catch {}
	if (!j || !j.ok) throw fail(502, "Couldn't send the code just now. Try again in a minute.");
}
const CODE_LIFE = 10 * 60e3, CODE_TRIES = 5, CODES_AN_HOUR = 5;
const codeHash = (email, code) => sha256hex(email + ":" + code);
async function sendCode(env, email, purpose) {
	const row = await env.DB.prepare("SELECT * FROM email_codes WHERE email = ?").bind(email).first();
	const t = now(), fresh = !row || t - (row.window_at || 0) > 3600e3;
	if (!fresh && (row.sent || 0) >= CODES_AN_HOUR) throw fail(429, "That's a lot of codes for one email. Wait an hour, then try again.");
	const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
	await env.DB.prepare("INSERT INTO email_codes (email, code_hash, pass, tries, sent, window_at, expires_at) VALUES (?, ?, ?, 0, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, pass = COALESCE(excluded.pass, email_codes.pass), tries = 0, sent = excluded.sent, window_at = excluded.window_at, expires_at = excluded.expires_at")
		.bind(email, await codeHash(email, code), purpose, fresh ? 1 : (row.sent || 0) + 1, fresh ? t : row.window_at, t + CODE_LIFE).run();
	await sendMail(env, email, code + " is your Celestin sign-in code", "Your Celestin sign-in code is " + code + ". It works for 10 minutes.\n\nIf you didn't try to sign in, someone may know your password: change it soon.",
		'<div style="font-family:system-ui,sans-serif;font-size:15px;color:#111"><p>Your Celestin code is</p><p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:8px 0">' + code + '</p><p style="color:#555">It works for 10 minutes. If you didn\'t try to sign in, someone may know your password: change it soon.</p></div>');
}
async function useCode(env, email, code, kind) {
	const row = await env.DB.prepare("SELECT * FROM email_codes WHERE email = ?").bind(email).first();
	if (!row || String(row.pass || "").split(":")[0] !== kind || row.expires_at < now()) throw fail(400, "That code has expired. Send a new one.");
	if ((row.tries || 0) >= CODE_TRIES) throw fail(429, "Too many wrong codes. Send a new one.");
	if (!sameString(await codeHash(email, String(code || "").replace(/\D/g, "")), row.code_hash)) {
		await env.DB.prepare("UPDATE email_codes SET tries = tries + 1 WHERE email = ?").bind(email).run();
		throw fail(400, "That code isn't right. Check the email and try again.");
	}
	await env.DB.prepare("DELETE FROM email_codes WHERE email = ?").bind(email).run();
	const u = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND email = ?").bind(String(row.pass).split(":")[1], email).first();
	if (!u) throw fail(400, "That account isn't there anymore.");
	return u;
}
async function loginVerify(req, env) {
	const b = await body(req);
	const u = await useCode(env, cleanEmail(b.email), b.code, "login");
	await env.DB.prepare("UPDATE users SET email_ok = 1 WHERE id = ?").bind(u.id).run();
	u.owner = ownerHere(req, env, u.id);
	const token = await newSession(env, u.id);
	return json({ token, me: await meOf(env, u) });
}
// Forgot password: a code goes to the email if there's a password account there (the answer is the same either way, so
// nobody learns who has an account); with the code, a new password, and every other sign-in ends
async function passwordForgot(req, env) {
	if (!mailOn(env)) throw fail(503, "Password resets by email aren't set up yet. Contact support.");
	const b = await body(req);
	const email = cleanEmail(b.email);
	const u = await env.DB.prepare("SELECT id, pass FROM users WHERE email = ?").bind(email).first();
	if (u && String(u.pass || "").startsWith("pbkdf2$")) await sendCode(env, email, "reset:" + u.id);
	return json({ ok: true, verify: true, email });
}
async function passwordReset(req, env) {
	const b = await body(req);
	const password = String(b.password || "");
	if (password.length < 8) throw fail(400, "Use a password of at least 8 characters.");
	const u = await useCode(env, cleanEmail(b.email), b.code, "reset");
	await env.DB.batch([
		env.DB.prepare("UPDATE users SET pass = ?, email_ok = 1 WHERE id = ?").bind(await hashPassword(password, env), u.id),
		env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id),
	]);
	u.owner = ownerHere(req, env, u.id);
	const token = await newSession(env, u.id);
	return json({ token, me: await meOf(env, u) });
}
async function loginResend(req, env) {
	const b = await body(req);
	const email = cleanEmail(b.email);
	const row = await env.DB.prepare("SELECT pass FROM email_codes WHERE email = ?").bind(email).first();
	if (!row || !/^(login|reset):/.test(row.pass || "")) throw fail(400, "Start again from the beginning.");
	await sendCode(env, email, row.pass);
	return json({ ok: true, verify: true, email });
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
	// the right password: then the code sent to the account's email
	if (mailOn(env)) {
		await sendCode(env, email, "login:" + u.id);
		return json({ verify: true, email });
	}
	u.owner = ownerHere(req, env, u.id);
	const token = await newSession(env, u.id);
	return json({ token, me: await meOf(env, u) });
}

// Deleting an account, by its owner: the account and its sign-ins, shared chats, tasks and their runs, pictures shared
// with apps and running jobs go. What each request cost stays for the owner's accounts but no longer points to anyone,
// and payments stay as tax and accounting law requires, without the name written for a QRIS payment.
async function deleteMe(env, user) {
	const q = (sql) => env.DB.prepare(sql).bind(user.id);
	await env.DB.batch([
		q("DELETE FROM sessions WHERE user_id = ?"),
		q("DELETE FROM shares WHERE user_id = ?"),
		q("DELETE FROM task_runs WHERE user_id = ?"),
		q("DELETE FROM tasks WHERE user_id = ?"),
		q("DELETE FROM uploads WHERE user_id = ?"),
		q("DELETE FROM support WHERE user_id = ?"),
		q("DELETE FROM jobs WHERE user_id = ?"),
		q("DELETE FROM skill_days WHERE user_id = ?"),
		q("UPDATE usage SET user_id = 'deleted' WHERE user_id = ?"),
		q("UPDATE payments SET note = NULL WHERE user_id = ?"),
		q("DELETE FROM users WHERE id = ?"),
	]);
	return json({ ok: true });
}

// ------------------------------------------------------------------ sign in with Google
// The site's Google button hands back an ID token Google signed. It's checked here against Google's published keys: the
// signature, that it was made for this site (GOOGLE_CLIENT_ID, from the Google Cloud console), that it's Google's and
// still fresh, and that Google has verified the email. The account is the one with that email: made on first sign-in
// (free credits and all), the same account as signing up with that email and a password. (email_ok: someone has proven
// the account's email is theirs, with a code sent to it or with Google)
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
			await env.DB.prepare("INSERT INTO users (id, email, pass, balance_mc, free_mc, free_reset_at, created_at, email_ok) VALUES (?, ?, ?, 0, ?, ?, ?, 1)").bind(u.id, email, "google$" + String(g.sub || ""), u.free_mc, u.free_reset_at, now()).run();
		} catch {
			// signed in twice at once: the other one made it
			u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
			if (!u) throw fail(500, "Couldn't make your account. Try again.");
		}
	} else if (!u.email_ok) {
		// made with a password and this email, and nobody has proven the email is theirs yet (signing up sends no code):
		// Google just has, so everyone signed in to it is signed out first. Whoever made it without owning the email can't
		// stay in, and can't get back in with the password (signing in with it asks for the code sent to this email)
		await env.DB.batch([
			env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id),
			env.DB.prepare("UPDATE users SET email_ok = 1 WHERE id = ?").bind(u.id),
		]);
	}
	u.owner = ownerHere(req, env, u.id);
	const token = await newSession(env, u.id);
	// the first name Google has, so the app can greet you by it (kept in your browser, not here)
	return json({ token, me: await meOf(env, u), made, name: String(g.given_name || g.name || "").slice(0, 40) });
}
async function authUser(req, env) {
	const token = bearer(req);
	if (!token) throw fail(401, "Sign in to use Celestin credits.");
	const row = await env.DB.prepare("SELECT u.* , s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?").bind(await sha256hex(token)).first();
	if (!row || row.expires_at < now()) throw fail(401, "Your session ended. Sign in again.");
	row.owner = ownerHere(req, env, row.id);
	return readyUser(env, row, await config(env));
}
// A user as everything that spends credits must see them: the window refilled, and free credits frozen once today's free
// use has cost the owner its budget (the budget was only checked when a window was handed out, so credits already in
// windows, and every new account's first window, could be spent past it. Found Nov 8). Scheduled tasks go through this
// too: they ran on the database's row as it was, so a free account's tasks could keep spending past the budget.
// Bought credits still work; the most free use can cost is the budget and a call already running
async function readyUser(env, row, c) {
	const u = await refill(env, row, c);
	if (!u.owner && !planOf(u, c).paid && (await freeSpentOut(env, c))) u.free_frozen = true;
	return u;
}

// ------------------------------------------------------------------ plans: Free, Plus, Max
// Everyone has a window of credits from their plan (the free_mc and free_reset_at columns, named from when only Free
// had one). The clock starts when the first one is spent; "hours" later the window is full again (Free can hand it back
// in shares instead, every "every" hours). On top of that, at most "week" credits come out of windows in 7 days (the
// week starts with the first credit, like the window). Windows are always spent before bought credits (packs), and
// bought credits are what keeps someone going when the window or the week has run out. Nobody is shown tokens or money,
// only credits.
//
// Free windows together stay inside the owner's budget: what they really cost (at the labs' prices) is added up each day
// (UTC), and once it reaches free.budgetIdr no free window refills and no new account gets its first until tomorrow.
// Paid plans and bought credits still work, and what's already in a window can still be used, so a crowd arriving at
// once (a post going viral) costs about the day's budget, never the owner's savings.

// the plan someone is on now: one they bought (until its month runs out), or Free (the owner: no limits)
function planOf(u, c) {
	if (u && u.owner) return { id: "owner", name: "Unlimited", paid: true, owner: true, credits: 0, hours: 5, every: 5, share: 0, stepMs: 5 * 3600e3, week: 0, month: 0, until: 0 };
	const plans = c.plans || [];
	// (a plan the owner has since taken off sale still runs out its month, as the first plan on sale)
	const bought = u && u.plan && Number(u.plan_until) > now() ? plans.find((p) => p.id === u.plan) || plans[0] : null;
	const p = bought || c.free;
	const credits = Number(p.credits) || 0, hours = Number(p.hours) || 24;
	const every = !bought && Number(c.free.every) > 0 && Number(c.free.every) < hours ? Number(c.free.every) : hours;
	return { id: bought ? bought.id : "free", name: bought ? bought.name : "Free", paid: !!bought, credits, hours, every, share: Math.round(credits * every / hours * 1000) / 1000, stepMs: every * 3600e3, week: Math.max(0, Number(p.week) || 0), month: Math.max(0, Number(p.month) || 0), days: Number(p.days) || 30, until: bought ? Number(u.plan_until) : 0 };
}
// what's been spent from windows this week (a week that's over counts nothing)
const weekUsed = (u) => (u.week_at && now() < u.week_at ? Math.max(0, u.week_mc || 0) : 0);
const UNLIMITED_MC = 1e9;
// a bought plan's month of credits still to use (what its payments added, less what's been used)
const monthLeft = (u, plan) => (plan.paid && plan.month ? Math.max(0, u.plan_mc || 0) : Infinity);
// what can come out of the window right now: what's left in it, no more than the week (Free) or the plan's month of
// credits (a bought plan) has left
function windowLeft(u, c) {
	const plan = planOf(u, c);
	if (plan.owner) return UNLIMITED_MC;
	// (today's free use has cost its budget: free credits wait for tomorrow)
	if (u.free_frozen && !plan.paid) return 0;
	let win = Math.max(0, u.free_mc || 0);
	if (plan.week) win = Math.min(win, Math.max(0, plan.week * 1000 - weekUsed(u)));
	return Math.min(win, monthLeft(u, plan));
}
// What a month of a plan (or days of one given by hand) does to an account. Credits never pile up: each month of a plan
// brings that month's credits, and what isn't used by the month's end is gone (period_at: when this month ends). The same
// plan paid early: its days go on the end, and its credits come when its month begins. Another plan: it starts now with
// its month of credits, and what was left of the old one (the smaller of its time and its credits left this month, plus
// any months paid ahead, as a share of its price) becomes extra days of the new one at the new one's price, so nobody
// loses what they paid for and nothing is given twice. A plan that wasn't running starts with a full window. (Pure:
// owner.mjs runs this same function.)
function planChange(u, plans, plan, days, t) {
	const span = (Number(plan.days) || 30) * 86400e3, d = (Number(days ?? plan.days) || 30) * 86400e3;
	const until = Number(u.plan_until) || 0, per = Number(u.period_at) || 0, running = !!u.plan && until > t;
	if (running && u.plan === plan.id) return { same: true, plan_until: until + d, period_at: per > 0 ? per : until };
	let extra = 0;
	if (running) {
		const old = plans.find((p) => p.id === u.plan) || plans[0] || plan, ospan = (Number(old.days) || 30) * 86400e3;
		const end = per > 0 ? Math.min(per, until) : until, price = (p) => Number(p.prices && p.prices.IDR) || 0;
		const left = Math.min(Math.max(0, end - t) / ospan, Number(old.month) > 0 ? Math.max(0, Number(u.plan_mc) || 0) / (old.month * 1000) : 1);
		const ahead = Math.max(0, until - Math.max(end, t)) / ospan;
		if (price(old) > 0 && price(plan) > 0) extra = Math.round((left + ahead) * price(old) / price(plan) * span);
	}
	const first = Math.min(d + extra, span);
	return { same: false, plan: plan.id, plan_until: t + d + extra, period_at: t + first, plan_mc: Math.round((Number(plan.month) || 0) * 1000 * first / span), free_mc: Math.round((Number(plan.credits) || 0) * 1000) };
}
async function startPlan(env, userId, plan, days) {
	// (two payments approved at once: the second goes again with what the first did)
	for (let tries = 0; tries < 5; tries++) {
		const u = await env.DB.prepare("SELECT plan, plan_until, plan_mc, period_at FROM users WHERE id = ?").bind(userId).first();
		if (!u) return false;
		const x = planChange(u, (await config(env)).plans || [], plan, days, now());
		const r = x.same ? await env.DB.prepare("UPDATE users SET plan_until = ?, period_at = ? WHERE id = ? AND plan_until = ?").bind(x.plan_until, x.period_at, userId, u.plan_until).run()
			: await env.DB.prepare("UPDATE users SET plan = ?, plan_until = ?, period_at = ?, plan_mc = ?, free_mc = ?, free_reset_at = 0, week_mc = 0, week_at = 0 WHERE id = ? AND plan_until = ?").bind(x.plan, x.plan_until, x.period_at, x.plan_mc, x.free_mc, userId, u.plan_until).run();
		if (r.meta && r.meta.changes) return true;
	}
	return false;
}
// the columns and tables added since the first version, put on an older database once (the first request after a deploy)
let COLS = null;
function columns(env) {
	if (!COLS) COLS = (async () => {
		const have = new Set(((await env.DB.prepare("PRAGMA table_info(users)").all()).results || []).map((r) => r.name));
		for (const [k, t] of [["plan", "TEXT"], ["plan_until", "INTEGER NOT NULL DEFAULT 0"], ["week_mc", "INTEGER NOT NULL DEFAULT 0"], ["week_at", "INTEGER NOT NULL DEFAULT 0"], ["plan_mc", "INTEGER NOT NULL DEFAULT 0"], ["email_ok", "INTEGER NOT NULL DEFAULT 0"], ["period_at", "INTEGER NOT NULL DEFAULT 0"]]) {
			if (have.has(k)) continue;
			// (two requests at once: the other one added it)
			try { await env.DB.prepare("ALTER TABLE users ADD COLUMN " + k + " " + t).run(); } catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
		}
		const jcols = new Set(((await env.DB.prepare("PRAGMA table_info(jobs)").all()).results || []).map((r) => r.name));
		if (jcols.size && !jcols.has("owner")) { try { await env.DB.prepare("ALTER TABLE jobs ADD COLUMN owner INTEGER NOT NULL DEFAULT 0").run(); } catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; } }
		// (a scheduled task kept by a Celestin Together teammate says which)
		const tcols = new Set(((await env.DB.prepare("PRAGMA table_info(tasks)").all()).results || []).map((r) => r.name));
		if (tcols.size && !tcols.has("member")) { try { await env.DB.prepare("ALTER TABLE tasks ADD COLUMN member TEXT").run(); } catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; } }
		const ucols = new Set(((await env.DB.prepare("PRAGMA table_info(usage)").all()).results || []).map((r) => r.name));
		for (const k of ["in_tok", "cached_tok", "out_tok", "ms", "first_ms", "write_tok"]) if (!ucols.has(k)) { try { await env.DB.prepare("ALTER TABLE usage ADD COLUMN " + k + " INTEGER NOT NULL DEFAULT 0").run(); } catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; } }
		await env.DB.prepare("CREATE TABLE IF NOT EXISTS support (id TEXT PRIMARY KEY, user_id TEXT, email TEXT NOT NULL, category TEXT, subject TEXT, message TEXT NOT NULL, details TEXT, status TEXT NOT NULL DEFAULT 'open', ip TEXT, created_at INTEGER NOT NULL)").run();
		await env.DB.prepare("CREATE INDEX IF NOT EXISTS support_user ON support (user_id, created_at)").run();
		await env.DB.prepare("CREATE TABLE IF NOT EXISTS email_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, pass TEXT, tries INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, window_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)").run();
		await env.DB.prepare("CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL)").run();
		await env.DB.prepare("CREATE INDEX IF NOT EXISTS uploads_user ON uploads (user_id, created_at)").run();
	})().catch((e) => { COLS = null; throw e; });
	return COLS;
}
const nextDay = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
const spentKey = () => "spent:" + new Date().toISOString().slice(0, 10);
const budgetUsd = (c) => (Number(c.free.budgetIdr) || 0) / (Number(c.free.usdIdr) || 18000);
// today's free use has cost the owner all of its budget (free credits are frozen until tomorrow)
async function freeSpentOut(env, c) {
	if (!(budgetUsd(c) > 0)) return false;
	const r = await env.DB.prepare("SELECT mc FROM free_days WHERE day = ?").bind(spentKey()).first();
	return ((r && r.mc) || 0) >= budgetUsd(c) * 1e6;
}
// the share of a charge that a free window paid for, at its real cost, added to today's total (a statement for the
// batch; a paid plan's window isn't free use)
function freeSpend(env, held, charged, usd) {
	if (held.free === false) return [];
	const fromFree = Math.min(Math.max(0, held.fromFree || 0), charged);
	if (!(fromFree > 0) || !(usd > 0)) return [];
	const micro = Math.round(usd * 1e6 * fromFree / Math.max(1, charged));
	return [env.DB.prepare("INSERT INTO free_days (day, mc) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET mc = mc + excluded.mc").bind(spentKey(), micro)];
}
async function grantFree(env, c, mc) {
	if (mc > 0 && budgetUsd(c) > 0) {
		const row = await env.DB.prepare("SELECT mc FROM free_days WHERE day = ?").bind(spentKey()).first();
		if (((row && row.mc) || 0) >= budgetUsd(c) * 1e6) return 0;
	}
	const cap = Math.round((Number(c.free.dailyCap) || 0) * 1000);
	if (!cap || mc <= 0) return mc;
	const day = new Date().toISOString().slice(0, 10);
	await env.DB.prepare("INSERT OR IGNORE INTO free_days (day, mc) VALUES (?, 0)").bind(day).run();
	const r = await env.DB.prepare("UPDATE free_days SET mc = mc + ? WHERE day = ? AND mc + ? <= ?").bind(mc, day, mc, cap).run();
	return r.meta && r.meta.changes ? mc : 0;
}
// how often a share comes back, and how big it is (every 0, or as long as the whole: the whole bucket at once)
function freeStep(c) {
	const hours = Number(c.free.hours) || 24, credits = Number(c.free.credits) || 0;
	const every = Number(c.free.every) > 0 && Number(c.free.every) < hours ? Number(c.free.every) : hours;
	return { every, share: Math.round(credits * every / hours * 1000) / 1000, stepMs: every * 3600e3 };
}
async function refill(env, user, c) {
	// a bought plan whose month is over: back on Free, with what's left of its window up to Free's, and a fresh week (a
	// week spent on the plan doesn't lock them out of Free's)
	if (user.plan && !(Number(user.plan_until) > now())) {
		const cap = Math.round((Number(c.free.credits) || 0) * 1000);
		await env.DB.prepare("UPDATE users SET plan = NULL, plan_mc = 0, period_at = 0, free_mc = MIN(free_mc, ?), week_mc = 0, week_at = 0 WHERE id = ? AND plan = ?").bind(cap, user.id, user.plan).run();
		user.plan = null;
		user.free_mc = Math.min(user.free_mc || 0, cap);
		user.plan_mc = user.period_at = user.week_mc = user.week_at = 0;
	}
	// a bought plan's next month: that month's credits, fresh (what the last one didn't use doesn't carry over; someone
	// away for months gets this month's, not all of them). The plan's last month is as long as what's left of it.
	const per = Number(user.period_at) || 0;
	if (user.plan && Number(user.plan_until) > now() && per > 0 && now() >= per) {
		const bought = (c.plans || []).find((p) => p.id === user.plan) || (c.plans || [])[0];
		if (bought) {
			const span = (Number(bought.days) || 30) * 86400e3, start = per + Math.floor((now() - per) / span) * span, end = Math.min(start + span, Number(user.plan_until));
			const mc = Math.round((Number(bought.month) || 0) * 1000 * Math.min(1, (end - start) / span));
			await env.DB.prepare("UPDATE users SET plan_mc = ?, period_at = ? WHERE id = ? AND period_at = ?").bind(mc, end, user.id, per).run();
			user.plan_mc = mc;
			user.period_at = end;
		}
	}
	const plan = planOf(user, c);
	if (plan.owner) return user;
	const full = Math.round(plan.credits * 1000);
	const due = user.free_reset_at && now() >= user.free_reset_at;
	// a full window that's never been touched since the amount went up (or an account from before free credits)
	const topUp = !user.free_reset_at && (user.free_mc || 0) < full;
	if (!due && !topUp) {
		// an empty free window that fills at midnight UTC is one the day's pool couldn't fill (a used one fills hours after use)
		if (!plan.paid && !(user.free_mc > 0) && user.free_reset_at === nextDay()) user.free_capped = true;
		return user;
	}
	const have = Math.max(0, user.free_mc || 0);
	// every share that's come due since the clock's last tick (someone away a day gets a full window, not more)
	const ticks = due ? 1 + Math.floor((now() - user.free_reset_at) / plan.stepMs) : 0;
	const add = Math.max(0, topUp ? full - have : Math.min(full - have, Math.round(ticks * plan.share * 1000)));
	if (add && !plan.paid && !(await grantFree(env, c, add))) {
		// today's free credits are all given out: this window fills tomorrow
		await env.DB.prepare("UPDATE users SET free_reset_at = ? WHERE id = ?").bind(nextDay(), user.id).run();
		user.free_reset_at = nextDay();
		user.free_capped = true;
		return user;
	}
	// not full yet: the clock keeps going, the next share on the same beat
	const next = have + add >= full ? 0 : user.free_reset_at + ticks * plan.stepMs;
	await env.DB.prepare("UPDATE users SET free_mc = MIN(free_mc + ?, ?), free_reset_at = ? WHERE id = ? AND free_reset_at = ?").bind(add, full, next, user.id, user.free_reset_at || 0).run();
	user.free_mc = Math.min(have + add, full);
	user.free_reset_at = next;
	return user;
}
// a new account's first bucket, if today's budget still has room
async function firstFree(env, c) {
	const full = Math.round((Number(c.free.credits) || 0) * 1000);
	const got = await grantFree(env, c, full);
	return { free_mc: got, free_reset_at: got || !full ? 0 : nextDay() };
}
// what someone can spend right now: their window (as far as the week allows), then what they bought
const spendable = (u, c) => windowLeft(u, c) + Math.max(0, u.balance_mc || 0);
const waitText = (t) => {
	const mins = Math.max(1, Math.ceil(Math.max(0, t - now()) / 60e3)), d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
	return d ? d + "d" + (h ? " " + h + "h" : "") : h ? h + "h" + (m ? " " + m + "m" : "") : m + "m";
};
// why there's nothing to spend, and when there will be (never what anything costs)
function outOfCredits(u, c) {
	const plan = planOf(u, c);
	if (u.free_frozen && !plan.paid) return fail(402, "Celestin's free credits for today are all used up: free use has a daily limit. They're back tomorrow. A credit pack keeps you going right now.");
	const more = " A credit pack keeps you going right now.";
	if (plan.paid && plan.month && monthLeft(u, plan) < 1000) {
		const next = Number(u.period_at) > now() && Number(u.period_at) < plan.until;
		return fail(402, "You've used this month's credits on " + plan.name + ". " + (next ? "Next month's arrive in " + waitText(u.period_at) + "." : "Your plan ends in " + waitText(plan.until) + "; another month of it brings new credits from then.") + " A credit pack keeps you going right now.");
	}
	if (plan.week && u.week_at > now() && weekUsed(u) >= plan.week * 1000 - 999) return fail(402, "You've used this week's credits" + (plan.paid ? " on " + plan.name : "") + ". They're back in " + waitText(u.week_at) + "." + more);
	if (u.free_capped && u.free_reset_at > now()) return fail(402, "Celestin's free credits for today are all used up. Yours come back in " + waitText(u.free_reset_at) + "." + more);
	if (u.free_reset_at > now() && plan.credits > 0) return fail(402, (plan.share < plan.credits ? "You've used your free credits for now. " + plan.share + " more come back in " : "You've used " + (plan.paid ? "your " + plan.name + " credits" : "your free credits") + " for these " + plan.hours + " hours. They're back in ") + waitText(u.free_reset_at) + "." + more);
	return fail(402, "You're out of credits. A credit pack keeps you going.");
}
// Hold mc: the window first (as far as the week allows), then bought credits. Null if there isn't enough. The window's
// clock and the week's start with their first credit.
async function take(env, userId, mc, c, owner = false) {
	for (let tries = 0; tries < 6; tries++) {
		// the owner on their own computer (owner: the request had the owner key): nothing is held (what's used is still
		// written down when it's charged), inside a daily budget of real money if one is set (OWNER_DAY_IDR, the last 24 hours)
		if (owner && isOwner(userId)) {
			const day = OWNER_DAY_IDR > 0 && await env.DB.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM usage WHERE user_id = ? AND created_at > ?").bind(userId, now() - 86400e3).first();
			if (OWNER_DAY_IDR > 0 && (Number(day && day.usd) || 0) * (Number(c.free.usdIdr) || 18000) >= OWNER_DAY_IDR) throw fail(402, "Your own testing budget for today (Rp" + OWNER_DAY_IDR.toLocaleString("id-ID") + ") is used up, so nothing more is spent. It frees up over the next 24 hours.");
			return { fromFree: 0, fromPaid: 0, free: false, owner: true };
		}
		const u = await env.DB.prepare("SELECT balance_mc, free_mc, free_reset_at, week_mc, week_at, plan_mc, plan, plan_until FROM users WHERE id = ?").bind(userId).first();
		if (!u) return null;
		const plan = planOf(u, c), t = now();
		// (free credits frozen for today are never held, whatever path asks: web search, pictures, video and voice hold
		// here without the request's check, and someone with bought credits too would be spending the frozen window first)
		const win = windowLeft(u, c), frozen = win > 0 && !plan.paid && (await freeSpentOut(env, c));
		const fromFree = Math.min(frozen ? 0 : win, mc), fromPaid = mc - fromFree;
		if (fromPaid > Math.max(0, u.balance_mc)) return null;
		// (a bought plan: what comes out of the window comes out of its month of credits too)
		const fromMonth = plan.paid && plan.month ? fromFree : 0;
		// one statement, so requests running at once (a team's pieces) can't overspend the window, the week, the month or
		// the balance, and don't trip over each other's either: the window's clock and the week start with their first
		// credit, a week that's over starts again from nothing, and only a real shortfall goes round again
		const r = await env.DB.prepare("UPDATE users SET free_mc = free_mc - ?1, balance_mc = balance_mc - ?2, free_reset_at = CASE WHEN free_reset_at = 0 AND ?1 > 0 THEN ?3 ELSE free_reset_at END, week_mc = (CASE WHEN week_at > ?4 THEN week_mc ELSE 0 END) + ?1, week_at = CASE WHEN week_at > ?4 THEN week_at WHEN ?1 > 0 THEN ?5 ELSE 0 END, plan_mc = plan_mc - ?8 WHERE id = ?6 AND free_mc >= ?1 AND balance_mc >= ?2 AND plan_mc >= ?8 AND (CASE WHEN week_at > ?4 THEN week_mc ELSE 0 END) + ?1 <= ?7")
			.bind(fromFree, fromPaid, t + plan.stepMs, t, t + 7 * 86400e3, userId, plan.week ? plan.week * 1000 : Number.MAX_SAFE_INTEGER, fromMonth).run();
		if (r.meta && r.meta.changes) return { fromFree, fromPaid, free: !plan.paid, month: fromMonth > 0, monthMc: plan.month * 1000 };
	}
	return null;
}
// What wasn't used goes back where it came from (and out of the week's count, and into the plan's month of credits): the
// window is counted as spent first. (The owner held nothing, so nothing goes back.)
function giveBack(env, userId, held, charged) {
	if (held.owner) return env.DB.prepare("SELECT 1");
	const usedFree = Math.min(held.fromFree, charged), back = held.fromFree - usedFree;
	// (a request that ran across a new month gives back into the new one, which is full already)
	return env.DB.prepare("UPDATE users SET free_mc = free_mc + ?, balance_mc = balance_mc + ?, week_mc = MAX(0, week_mc - ?), plan_mc = MIN(plan_mc + ?, MAX(plan_mc, ?)) WHERE id = ?").bind(back, held.fromPaid - (charged - usedFree), back, held.month ? back : 0, held.monthMc || 0, userId);
}
// what the owner's own use has really cost, in rupiah: the last day, week and 30 days
async function ownerSpend(env, userId, c) {
	const t = now(), rate = Number(c.free.usdIdr) || 18000;
	const r = await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN created_at > ?2 THEN cost_usd ELSE 0 END), 0) AS d, COALESCE(SUM(CASE WHEN created_at > ?3 THEN cost_usd ELSE 0 END), 0) AS w, COALESCE(SUM(cost_usd), 0) AS m FROM usage WHERE user_id = ?1 AND created_at > ?4")
		.bind(userId, t - 864e5, t - 7 * 864e5, t - 30 * 864e5).first().catch(() => null);
	const idr = (usd) => Math.round((Number(usd) || 0) * rate);
	return { day: idr(r && r.d), week: idr(r && r.w), month: idr(r && r.m) };
}
async function meOf(env, user) {
	const c = await config(env);
	const fresh = await env.DB.prepare("SELECT balance_mc, free_mc, free_reset_at, week_mc, week_at, plan_mc, plan, plan_until, period_at FROM users WHERE id = ?").bind(user.id).first();
	const u = { ...user, ...(fresh || {}) };
	u.owner = !!user.owner && isOwner(u.id);
	const plan = planOf(u, c);
	const pays = await env.DB.prepare("SELECT id, method, pack, amount, currency, credits_mc, status, created_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 10").bind(user.id).all();
	const win = plan.owner ? null : { left: windowLeft(u, c) / 1000, of: plan.credits, hours: plan.hours, every: plan.every, share: plan.share, backAt: u.free_reset_at || null };
	return {
		id: user.id,
		email: user.email,
		// what can be spent right now
		credits: spendable(u, c) / 1000,
		// bought credits (packs)
		paid: Math.max(0, u.balance_mc || 0) / 1000,
		plan: { id: plan.id, name: plan.name, paid: plan.paid, until: plan.until || null, ...(plan.owner ? { unlimited: true } : {}) },
		owner: !!plan.owner,
		// the owner: what the AI has really cost (the gateway's price, its fee included), to weigh against a subscription
		...(plan.owner ? { spend: await ownerSpend(env, u.id, c) } : {}),
		// the owner's account somewhere without the owner key: told where its unlimited is
		...(isOwner(u.id) && !plan.owner ? { ownerAway: true } : {}),
		window: win,
		week: plan.week ? { left: Math.max(0, plan.week * 1000 - weekUsed(u)) / 1000, of: plan.week, backAt: weekUsed(u) ? u.week_at : null } : null,
		// a bought plan's month of credits (what's left of this month's; backAt: when the next month's arrive, if the plan
		// runs on)
		month: plan.paid && plan.month ? { left: monthLeft(u, plan) / 1000, of: plan.month, backAt: Number(u.period_at) > now() && Number(u.period_at) < plan.until ? Number(u.period_at) : null } : null,
		// (the window, as pages from before plans read it)
		free: win,
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
// (only: the gateway numbers to use, for the owner's demo; none of them set up: every gateway)
function gateways(env, only) {
	const out = [];
	if (env.WAVESPEED_KEY) out.push({ n: "ws", base: "https://llm.wavespeed.ai/v1", key: String(env.WAVESPEED_KEY).trim(), fee: Number(env.WAVESPEED_FEE) || 1, aliases: {} });
	for (const n of ["", "2", "3"]) {
		const url = env["GATEWAY" + n + "_URL"], key = env["GATEWAY" + n + "_KEY"];
		if (!url || !key) continue;
		let aliases = {};
		try { aliases = JSON.parse(env["GATEWAY" + n + "_ALIASES"] || "{}") || {}; } catch {}
		// (a key never holds control characters: Ctrl+V in a Windows prompt types one instead of pasting)
		out.push({ n: n || "1", base: String(url).trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, ""), key: String(key).replace(/[\x00-\x1f\x7f]/g, "").trim(), fee: Number(env["GATEWAY" + n + "_FEE"]) || 1, aliases, prices: String(env["GATEWAY" + n + "_PRICES"] || "").trim(), idr: Number(env.IDR_PER_USD) || 0 });
	}
	if (only && only.length) { const some = out.filter((g) => only.includes(g.n)); if (some.length) return some; }
	return out;
}
// the owner's demo: only the gateways it's set to use
// the order the gateways are asked in: the demo's own (MarkasAI first) or everyone's (Flaz first); where a gateway sits in it
const orderFor = (c, owner) => { const o = c && (owner ? c.ownerGatewayOrder : c.gatewayOrder); return Array.isArray(o) && o.length ? o.map(String) : null; };
// (WaveSpeed, when it's set up, stays first, as it always was; a gateway the order doesn't name comes after the ones it does)
const rankIn = (order, n) => { if (n === "ws") return -1; const k = order ? order.indexOf(String(n)) : -1; return k < 0 ? 99 : k; };
// what a gateway's own short names are, when its list doesn't say (by its address)
const KNOWN_ALIASES = {
	routerku: {
		"opus-5": "anthropic/claude-opus-5", "sonnet-5": "anthropic/claude-sonnet-5", "haiku-45": "anthropic/claude-haiku-4.5", "fable-5": "anthropic/claude-fable-5",
		"gpt-6-astra": "openai/gpt-6-astra", "gpt-55": "openai/gpt-5.5", "gpt-55-codex": "openai/gpt-5.5-codex", sol: "openai/gpt-5.6-sol", "gpt-4o": "openai/gpt-4o",
		"gemini-31": "google/gemini-3.1-pro", "gemini-36": "google/gemini-3.6-flash", "grok-45": "x-ai/grok-4.5", "glm-53": "z-ai/glm-5.3", "kimi-k3": "moonshotai/kimi-k3",
	},
};
const GWS = new Map();
// rupiah to the dollar, for a gateway that prices in rupiah: today's rate (asked twice a day), or 18,000 if no one answers
let IDR = { at: 0, v: 18000 };
async function idrPerUsd(g) {
	if (g && g.idr > 0) return g.idr;
	if (Date.now() - IDR.at < 12 * 3600e3) return IDR.v;
	try {
		const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(5000) });
		const v = Number((await r.json()).rates.IDR);
		if (v > 5000 && v < 50000) IDR = { at: Date.now(), v };
		else IDR.at = Date.now();
	} catch { IDR.at = Date.now(); }
	return IDR.v;
}
// one model's price as a list gives it: rupiah per million tokens (MarkasAI's, and others'), or dollars a token
// (OpenRouter's way); null when it doesn't say
function itemPrice(m, idr) {
	if (!m || typeof m !== "object") return null;
	const p = m.pricing && typeof m.pricing === "object" ? m.pricing : m;
	const n = (v) => (v == null || v === "" ? NaN : Number(v));
	let pin = NaN, pout = NaN;
	if (Number.isFinite(n(p.inputIdrPerMTok))) { pin = n(p.inputIdrPerMTok) / idr / 1e6; pout = n(p.outputIdrPerMTok) / idr / 1e6; }
	else if (Number.isFinite(n(p.input_idr_per_m))) { pin = n(p.input_idr_per_m) / idr / 1e6; pout = n(p.output_idr_per_m) / idr / 1e6; }
	else if (Number.isFinite(n(p.prompt)) && Number.isFinite(n(p.completion))) { pin = n(p.prompt); pout = n(p.completion); }
	// (MarkasAI's own list, read with its key: {currency: "IDR", per_tokens: 1000000, input, output})
	else if (Number.isFinite(n(p.input)) && Number.isFinite(n(p.output)) && Number(p.per_tokens) > 0) { const per = Number(p.per_tokens) * (String(p.currency || "USD").toUpperCase() === "IDR" ? idr : 1); pin = n(p.input) / per; pout = n(p.output) / per; }
	return Number.isFinite(pin) && Number.isFinite(pout) && pin >= 0 && pout > 0 ? { pin, pout } : null;
}
// a gateway that just turned Celestin's key down (no balance, a budget reached): tried last for ten minutes
const GW_DOWN = new Map();
const gwDown = (n) => (Date.now() - (GW_DOWN.get(n) || 0) < 600e3 ? 1 : 0);
// a model's name with its maker and every mark taken off: "anthropic/claude-opus-5.5" → "claudeopus55"
const bareKey = (id) => String(id).toLowerCase().replace(/:.*$/, "").replace(/^.*\//, "").replace(/[^a-z0-9]/g, "");
async function gatewayCatalog(g) {
	let c = GWS.get(g.base) || { at: 0, ids: [], byKey: new Map(), failed: 0 };
	if (c.ids.length && Date.now() - c.at < 3600e3) return c;
	// asked again at most every five minutes if it didn't answer (each chat waits on this)
	if (!c.ids.length && c.failed && Date.now() - c.failed < 300e3) return c;
	try {
		const r = await fetch(g.base + "/models", { headers: { Authorization: "Bearer " + g.key }, signal: AbortSignal.timeout(8000) });
		const t = await r.text();
		if (!r.ok) throw new Error(r.status + " " + errorText(t, t.replace(/\s+/g, " ").slice(0, 160) || r.statusText));
		const j = JSON.parse(t);
		const raw = Array.isArray(j) ? j : j.data || j.models || j.rows || [];
		const items = raw.map((m) => (typeof m === "string" ? { id: m } : { id: m.id || m.name, name: m.display_name || m.name || m.title || "" })).filter((m) => m.id).map((m) => ({ id: String(m.id), name: String(m.name || "") }));
		if (!items.length) throw new Error("no models");
		// what each model costs there: from its own list, or from the price list it points to
		const prices = new Map();
		const idr = await idrPerUsd(g);
		for (const m of raw) { const p = itemPrice(m, idr); if (p && m.id) prices.set(String(m.id), p); }
		if (g.prices) {
			try {
				const pr = await fetch(g.prices, { signal: AbortSignal.timeout(8000) });
				const pj = await pr.json();
				const list = Array.isArray(pj) ? pj : pj.data || pj.models || pj.rows || [];
				const byBare = new Map(items.map((m) => [bareKey(m.id), m.id]));
				for (const m of list) { const id = m && (m.id || m.name), p = itemPrice(m, idr), mine = id && (items.some((x) => x.id === id) ? id : byBare.get(bareKey(id))); if (p && mine && !prices.has(mine)) prices.set(mine, p); }
			} catch (e) { console.log("gateway " + g.n + " price list unreadable: " + String((e && e.message) || e).slice(0, 120)); }
		}
		const byKey = new Map();
		const put = (k, id) => { if (k && !byKey.has(k)) byKey.set(k, id); };
		// its own names, the plain one before a relayed one ("claude-fable-5" before "claude-fable-5-openrouter"); one it
		// only has relayed ("kimi-k2-6-openrouter") is still found by its own name; then what its list says each one is
		// ("Gemini 3.1 Pro" for "gemini-31")
		for (const m of items.slice().sort((a, b) => a.id.length - b.id.length)) put(bareKey(m.id), m.id);
		for (const m of items) put(bareKey(m.id.replace(/-(openrouter(-backup)?|or)$/i, "")), m.id);
		for (const m of items) if (m.name && m.name !== m.id) put(bareKey(m.name), m.id);
		// its picture and video models (a gateway that lists them with type: image or video, as MarkasAI does)
		const objs = raw.map((m) => (typeof m === "string" ? { id: m } : m)).filter((m) => m && m.id);
		const typed = objs.some((m) => m.type);
		const media = objs.map((m) => ({ m, kind: mediaKindOf(m, typed) })).filter((x) => x.kind).map(({ m, kind }) => ({ id: String(m.id), type: kind, endpoint: String(m.endpoint || ""), pricing: m.pricing && typeof m.pricing === "object" ? m.pricing : {}, maxN: Number(m.max_images_per_request || m.max_videos_per_request) || 1, maxSecs: Number(m.max_duration_seconds) || (kind === "video" && !typed ? 12 : 15), voices: Array.isArray(m.voices) ? m.voices.map(String) : null }));
		c = { at: Date.now(), ids: items.map((m) => m.id), byKey, failed: 0, prices, media };
		// everything it lists, as it names them (the server's log: what the gateway has, media models included)
		console.log("gateway " + g.n + " lists " + items.length + ": " + items.map((m) => m.id).join(", "));
	} catch (e) {
		// why, for the server's log (the gateway's own words; never the key)
		c = { ...c, failed: Date.now(), error: String((e && e.message) || e).slice(0, 200) };
		console.log("gateway " + g.n + " list unreadable: " + c.error + " (its key: " + g.key.length + " characters, " + (/^sk-/.test(g.key) ? "starts sk-" : "doesn't start sk-") + ")");
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
		// "claude-sonnet-5" may be "sonnet-5" there: the family word left off; "qwen3.8-max-0902" may be "qwen3.8-max": its
		// date left off (the gateway's name for the latest)
		const hit = c.byKey.get(k) || c.byKey.get(k.replace(/^(claude|gpt|gemini|grok)/, "")) || (/[a-z]\d{4}$/.test(k) && c.byKey.get(k.slice(0, -4)));
		return hit ? [hit] : [];
	}
	return [...new Set([model, name, name.replace(/(\d)\.(\d)/g, "$1-$2")])];
}
const provider = (id) => String(id).split("/")[0];

function routes(env, model, web, tools, price, order) {
	const out = [];
	const lab = model.split("/")[0], name = model.slice(lab.length + 1).replace(/:.*$/, "");
	const gws = [];
	// (a request reads about three times what it writes: the price that matters weighs both that way)
	const weigh = (p) => 3 * p.pin + p.pout;
	for (const g of gateways(env)) {
		const names = gatewayNames(g, model);
		if (!names.length) continue;
		const c = GWS.get(g.base), own = c && c.prices ? names.map((x) => c.prices.get(x)).find(Boolean) : null;
		const fee = own && price && weigh(price) > 0 ? weigh(own) / weigh(price) : g.fee;
		gws.push({ kind: "gw", gw: g.n, lab, url: g.base + "/chat/completions", headers: { Authorization: "Bearer " + g.key }, names, fee, native: false, down: gwDown(g.n) });
	}
	// one that just failed goes last; then the order set (Flaz first, or MarkasAI first in the demo); then the cheaper
	gws.sort((a, b) => a.down - b.down || rankIn(order, a.gw) - rankIn(order, b.gw) || a.fee - b.fee);
	out.push(...gws);
	if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN && ["openai", "anthropic", "google", "x-ai"].includes(lab)) {
		const base = "https://api.cloudflare.com/client/v4/accounts/" + env.CF_ACCOUNT_ID + "/ai/v1/";
		const headers = { Authorization: "Bearer " + env.CF_API_TOKEN, ...(env.CF_GATEWAY ? { "cf-aig-gateway-id": env.CF_GATEWAY } : {}) };
		// Anthropic writes a version with a dash (claude-opus-5-5), OpenRouter with a dot (claude-opus-5.5)
		const names = lab === "anthropic" ? [...new Set(["anthropic/" + name.replace(/(\d)\.(\d)/g, "$1-$2"), "anthropic/" + name])] : [(lab === "x-ai" ? "xai" : lab) + "/" + name];
		if (lab === "anthropic") out.push({ kind: "claude", lab, url: base + "messages", headers, names, fee: 1.05, native: true });
		if (lab === "openai" && web && !tools) out.push({ kind: "responses", lab, url: base + "responses", headers, names, fee: 1.05, native: true });
		out.push({ kind: "gateway", lab, url: base + "chat/completions", headers, names, fee: 1.05, native: false });
	}
	if (env.OPENROUTER_KEY) out.push({ kind: "openrouter", lab, url: orBase(env) + "/chat/completions", headers: { Authorization: "Bearer " + env.OPENROUTER_KEY, "HTTP-Referer": env.SITE_URL || "https://andromeda.app", "X-Title": "Celestin" }, names: [model], fee: 1, native: true });
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
async function reachOf(env, only) {
	const cf = !!(env.CF_ACCOUNT_ID && env.CF_API_TOKEN), gws = gateways(env, only);
	const or = !!env.OPENROUTER_KEY && (!(gws.length || cf) || (await orFunded(env)));
	// where the studio's models come from: this server (WaveSpeed) or OpenRouter's own list
	const gwm = !wsOn(env) && gws.length ? (await gwMedia(env, only)).length > 0 : false;
	const mediaFrom = wsOn(env) || gwm ? "server" : env.OPENROUTER_KEY ? "openrouter" : "";
	if (or) return { all: true, only: "", skip: "", media: true, mediaFrom };
	const out = { all: false, only: cf ? "^(openai|anthropic|google|x-ai)/" : "^$", skip: "^openai/(gpt-oss|.*-pro$|.*codex|.*deep-research)|:", media: !!mediaFrom, mediaFrom };
	if (gws.length) {
		const cats = await Promise.all(gws.map(gatewayCatalog));
		if (cats.some((c) => c.ids.length)) {
			const ids = [...(await prices(env)).keys()].filter((id) => !/:/.test(id));
			out.models = ids.filter((id) => gws.some((g, i) => cats[i].ids.length && gatewayNames(g, id).length));
			// (and what it has that OpenRouter doesn't list yet, with the price to be safe with: the site uses one only where
			// the leaderboards rate it)
			const fresh = (await freshModels(env)).filter((f) => !only || gws.some((g) => gatewayNames(g, f.id).length));
			if (fresh.length) {
				out.models.push(...fresh.map((f) => f.id));
				out.fresh = fresh.map((f) => ({ id: f.id, name: f.gw, pin: f.pin * 1e6, pout: f.pout * 1e6 }));
			}
			// (the demo's own narrower list isn't kept as everyone's)
			if (!only) await keepReach(env, out.models);
		} else {
			// no list could be read: the last one that was (a model the gateway doesn't have is never asked for); none
			// kept yet, every model is tried, the names a gateway doesn't know falling through
			const last = await lastReach(env);
			if (last.length) { out.models = last; out.stale = true; } else out.all = true;
			// the gateway turning down the owner's key itself: the owner is told, by email
			const refused = cats.find((c) => /^40[123]\b/.test(c.error || ""));
			if (refused) await alertOwner(env, "gateway", "Your AI gateway turned down Celestin's key, so nobody can get answers right now. What it said: " + refused.error.replace(/ \(its key:.*$/, "") + "\n\nWhat to do: open your gateway's dashboard (Flaz), go to the API keys, and unblock the key Celestin uses (or make a new key and send it to Claude). Check the wallet balance, and any budget cap on the key.");
		}
	}
	return out;
}
// A model the gateway has that OpenRouter doesn't list yet (a new release the gateway added first): what it is, from the
// gateway's own name (its maker by its family word, or the maker it's filed under), and a price to be safe with until
// OpenRouter lists it: twice the dearest of that maker's models the gateway also has, so a new model never costs the
// owner more than it brings in. Text models only. The day OpenRouter lists it, its own entry and price take over.
const LAB_BY_NAME = [[/^(claude|opus|sonnet|haiku|fable)/, "anthropic"], [/^(gpt|chatgpt|o\d)/, "openai"], [/^(gemini|gemma)/, "google"], [/^grok/, "x-ai"], [/^deepseek/, "deepseek"], [/^(qwen|qwq)/, "qwen"], [/^kimi/, "moonshotai"], [/^glm/, "z-ai"], [/^minimax/, "minimax"], [/^mimo/, "xiaomi"], [/^(mistral|codestral|magistral|devstral)/, "mistralai"], [/^llama/, "meta-llama"]];
const NOT_TEXT = /image|imagine|video|veo|imagen|flux|banana|sora|kling|tts|whisper|embed|audio|music|lyria|speech|realtime|moderation|seedance|seedream|hailuo|midjourney|dall-?e|transcri|rerank|search|deep-research/i;
let FRESH = { at: 0, list: [] };
async function freshModels(env) {
	if (Date.now() - FRESH.at < 600e3) return FRESH.list;
	const gws = gateways(env), list = [];
	if (gws.length) {
		const cats = await Promise.all(gws.map(gatewayCatalog));
		const map = await prices(env);
		const known = [...map.keys()].filter((id) => !/:/.test(id) && !NOT_TEXT.test(id));
		const seen = new Set();
		gws.forEach((g, i) => {
			if (!cats[i].ids.length) return;
			// what the gateway's names already stand for, and what each maker's models cost there
			const served = known.filter((id) => gatewayNames(g, id).length);
			const taken = new Set(served.flatMap((id) => gatewayNames(g, id)));
			// (every model OpenRouter lists, by its bare name: one the gateway only spells differently, "gemini-2.0-flash" for
			// "gemini-2.0-flash-001" or "kimi-k2-5-260127" for "kimi-k2.5", is an old one, not a new release)
			const keys = known.map(bareKey);
			for (const gid of cats[i].ids) {
				// (a model its own list calls a picture or video model is never a chat model)
				if (taken.has(gid) || NOT_TEXT.test(gid) || (cats[i].media || []).some((x) => x.id === gid) || /-(openrouter(-backup)?|or|backup)$/i.test(gid)) continue;
				const bare = gid.toLowerCase().replace(/^.*\//, "");
				const lab = gid.includes("/") ? gid.split("/")[0].toLowerCase().replace(/^xai$/, "x-ai") : (LAB_BY_NAME.find(([re]) => re.test(bare)) || [])[1];
				if (!lab) continue;
				const id = lab + "/" + bare, bk = bareKey(id);
				if (map.has(id) || seen.has(id) || keys.some((k) => k.length >= 6 && bk.length >= 6 && (k.startsWith(bk) || bk.startsWith(k)))) continue;
				// what it's safe to charge: twice the dearest of that maker's models, on the gateway or anywhere OpenRouter lists
				// them (OpenAI's -pro ones aside, which think for minutes at many times the price), so a new model never costs the
				// owner more than it brings in
				const theirs = known.filter((k) => k.startsWith(lab + "/") && !/^openai\/.*-pro$/.test(k)).map((k) => map.get(k)).filter((p) => p && p.pout > 0);
				if (!theirs.length) continue;
				const dear = theirs.reduce((a, b) => (b.pout > a.pout ? b : a));
				seen.add(id);
				list.push({ id, gw: gid, pin: dear.pin * 2, pout: dear.pout * 2, pcr: undefined, pcw: undefined, mo: dear.mo, fresh: true });
			}
		});
		// (what the gateway turned out to have that's new, for the server's log)
		if (list.length) console.log("new on the gateway, not on OpenRouter yet: " + list.map((f) => f.id + " (as " + f.gw + ")").join(", "));
	}
	FRESH = { at: Date.now(), list };
	return list;
}
// The last list of models the gateway gave, kept (only when it changes) for when it can't be read
let REACH_LAST = null;
async function keepReach(env, models) {
	const v = JSON.stringify(models);
	if (REACH_LAST === v || !models.length) return;
	REACH_LAST = v;
	await env.DB.prepare("INSERT INTO config (k, v) VALUES ('reach-last', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(v).run().catch(() => {});
}
async function lastReach(env) {
	try { const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'reach-last'").first(); const list = row ? JSON.parse(row.v) : []; return Array.isArray(list) ? list : []; }
	catch { return []; }
}
// Telling the owner something's wrong that only they can fix, by email, at most once an hour for each kind of problem
async function alertOwner(env, kind, text) {
	try {
		if (!mailOn(env)) return;
		const k = "alert-" + kind, row = await env.DB.prepare("SELECT v FROM config WHERE k = ?").bind(k).first();
		if (row && now() - Number(row.v) < 3600e3) return;
		await env.DB.prepare("INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, String(now())).run();
		const to = String((await config(env)).support || "").trim();
		if (!to) return;
		await sendMail(env, to, "[Celestin] Needs you: " + (kind === "gateway" ? "the AI gateway turned down Celestin's key" : kind), text, "<div style=\"font-family:system-ui,sans-serif;font-size:15px;color:#111;white-space:pre-wrap\">" + escHtml(text) + "</div>");
	} catch {}
}
function errorText(t, fallback) {
	try {
		let j = JSON.parse(t);
		if (Array.isArray(j)) j = j[0];
		// (FastAPI-built gateways, LiteLLM among them, say it as "detail")
		const m = j?.error?.message || j?.errors?.[0]?.message || j?.message || (typeof j?.detail === "string" ? j.detail : j?.detail?.error || j?.detail?.[0]?.msg);
		if (m) return String(m).slice(0, 500);
	} catch {}
	return String(fallback || "The AI provider said no.").slice(0, 300);
}

// The request as an OpenAI-format way takes it. OpenRouter takes it as the site sent it, with each lab's own web search
// at its most thorough when the site asks for a search. Cloudflare's chat endpoint gets plain OpenAI chat: no OpenRouter
// fields, no caching marks (only Claude reads them, and Claude goes the Anthropic way), the thinking level as
// reasoning_effort, max_completion_tokens for OpenAI (its reasoning models refuse max_tokens, and temperature), and the
// usage asked for at the end of a stream
// gateways that refused Claude's caching marks (asked without them from then on)
const GW_NOCACHE = new Set();
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
	// Claude through a rupiah gateway (LiteLLM, which hands the marks on to Claude) keeps its caching marks: without them
	// every call re-reads the whole conversation at full price instead of a tenth. A gateway that refuses them is asked
	// again without, and remembered (GW_NOCACHE)
	const keepMarks = way.kind === "gw" && way.lab === "anthropic" && !GW_NOCACHE.has(way.gw);
	out.messages = (b.messages || []).map((m) => {
		const x = { role: m.role, content: Array.isArray(m.content) ? m.content.map(({ cache_control, ...p }) => (keepMarks && cache_control ? { ...p, cache_control } : p)) : m.content == null ? "" : m.content };
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

// A request's input, in tokens, before it's sent (held against credits; the real count settles it): text at about 3
// characters a token, a picture sent as data at what models bill for one (about 1,600 at most), and sound sent as data by
// its length (base64 of 32 kbps speech: about 1 token per 100 characters), never by the size of its encoding
function inTokensOf(b) {
	let media = 0;
	const text = JSON.stringify(b.messages || [], (k, v) => {
		if (typeof v !== "string" || v.length < 4000) return v;
		if (/^data:image\//.test(v)) { media += 1600; return ""; }
		if (/^data:/.test(v) || (k === "data" && /^[A-Za-z0-9+/=\r\n]+$/.test(v.slice(0, 4000)))) { media += Math.ceil(v.length / 100); return ""; }
		return v;
	});
	return Math.ceil((text.length + (b.tools ? JSON.stringify(b.tools).length : 0)) / 3) + media;
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
	// (LiteLLM-style gateways also say Claude's as cache_read_input_tokens / cache_creation_input_tokens)
	const read = Math.min(prompt, u.prompt_tokens_details?.cached_tokens || u.cache_read_input_tokens || 0);
	const claude = way.lab === "anthropic";
	let wrote = Math.min(prompt - read, u.prompt_tokens_details?.cache_write_tokens || u.cache_creation_input_tokens || 0);
	// a gateway that keeps Claude's cache marks bills writing the cache at 1.25x: when its reply doesn't say how much it
	// wrote, what wasn't read from the cache is taken as written, once there's enough to cache (from 1,024 tokens), so the
	// price never comes in under what the owner pays
	const pd = u.prompt_tokens_details && typeof u.prompt_tokens_details === "object" ? u.prompt_tokens_details : {};
	const told = "cache_write_tokens" in pd || "cache_creation_input_tokens" in u || "cache_creation_input_tokens" in pd;
	if (claude && way.kind === "gw" && !told && !GW_NOCACHE.has(way.gw) && prompt - read >= 1024) wrote = prompt - read;
	// Gemini leaves its thinking out of completion_tokens but bills it: it's in the total
	const out = Math.max(u.completion_tokens || 0, (u.total_tokens || 0) - (u.prompt_tokens || 0)) || Math.ceil((outChars || 0) / 4);
	const list = (prompt - read - wrote) * price.pin + read * (price.pcr ?? (claude ? price.pin * 0.1 : price.pin)) + wrote * (price.pcw ?? (claude ? price.pin * 1.25 : price.pin)) + out * price.pout + (u.web_searches || 0) * 0.01;
	return { list, real: list * (way.fee ?? 1) };
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
// No search key: a model that searches the web for itself finds the sources (through the rupiah gateway, which has the
// same searching models; WaveSpeed's models with web search; or OpenRouter's web plugin), so search works from the start.
// Only what it actually cites is kept (a model that answered from memory isn't searching, and its links aren't trusted),
// however the way says it: OpenAI-style annotations, a list of citations (Grok, Perplexity), Gemini's grounding, or
// Claude's own citations. A way that answered without searching isn't asked again for an hour. About a cent a search,
// charged like anything else.
const SEARCHERS = ["x-ai/grok-4.7", "openai/gpt-5.4-nano", "google/gemini-3.5-flash-lite", "anthropic/claude-haiku-5.5", "openai/gpt-4o-mini"];
const SEARCH_OFF = new Map(); // a gateway that answered without searching: not asked again for an hour
async function modelSearch(env, q, n, order) {
	const gws = gateways(env).sort((a, b) => rankIn(order, a.n) - rankIn(order, b.n));
	await Promise.all(gws.map(gatewayCatalog));
	const ways = [...gws.map((g) => ({ id: g.n === "ws" ? "ws" : "gw" + g.n, base: g.base, key: g.key, g })), ...(env.OPENROUTER_KEY ? [{ id: "or", base: orBase(env), key: env.OPENROUTER_KEY }] : [])];
	const ask = "Search the web now for: " + q + "\n\nThen reply with ONLY JSON: {\"results\": [{\"title\": \"...\", \"url\": \"the page's address\", \"text\": \"what that page says that matters here, in 2 to 4 sentences, with its date if it has one\"}]}: up to " + n + " results from different sources, the most useful and recent first.";
	let usd = 0;
	for (const w of ways) {
		if (Date.now() - (SEARCH_OFF.get(w.id) || 0) < 3600e3) continue;
		models: for (const model of SEARCHERS) {
			// (a gateway's own name for it; one it doesn't have: the next)
			const name = w.g ? gatewayNames(w.g, model)[0] : model;
			if (!name) continue;
			for (const extra of [{ plugins: [{ id: "web", max_results: n }], web_search_options: { search_context_size: "medium" } }, { web_search_options: { search_context_size: "medium" } }]) {
				let r;
				try {
					r = await fetch(w.base + "/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + w.key, "Content-Type": "application/json" }, body: JSON.stringify({ model: name, messages: [{ role: "user", content: ask }], max_tokens: 2000, temperature: 0, ...extra }), signal: AbortSignal.timeout(40000) });
				} catch { continue models; }
				// a model it doesn't have: the next one; settings it doesn't take: the plainer form
				if (r.status === 400 || r.status === 422) continue;
				if (!r.ok) continue models;
				const j = await r.json().catch(() => null);
				usd += Number(j?.usage?.cost) || 0.012;
				const msg = j?.choices?.[0]?.message || {};
				const grounding = (Array.isArray(j?.vertex_ai_grounding_metadata) ? j.vertex_ai_grounding_metadata : [j?.vertex_ai_grounding_metadata]).flatMap((g) => (g && g.groundingChunks) || []).map((c) => c && c.web && { url: c.web.uri, title: c.web.title });
				const claude = ((msg.provider_specific_fields && msg.provider_specific_fields.citations) || []).flat();
				const cites = [...(msg.annotations || []).map((a) => a.url_citation || a), ...(Array.isArray(j?.citations) ? j.citations : []).map((u) => (typeof u === "string" ? { url: u } : u)), ...grounding, ...claude].filter((c) => c && /^https?:\/\//.test(String(c.url || "")));
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
	const held = await take(env, user.id, mt.toMc(0.06), c, !!user.owner);
	if (!held) return [];
	let got = { results: [], usd: 0 };
	try { got = await modelSearch(env, q, n, orderFor(c, user.owner)); }
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
// A model that thinks so long before its first word that the gateway gives up (about two minutes with nothing sent): the
// level it was asked at is remembered as too much for it, for everyone, and the next level down is sent from then on.
// (The owner still pays the gateway for what it thought, so each one is worth never repeating.)
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
let SLOW = { at: 0, map: {} };
async function slowEfforts(env) {
	if (Date.now() - SLOW.at < 300e3) return SLOW.map;
	try { const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'slow-efforts'").first(); SLOW = { at: Date.now(), map: row ? JSON.parse(row.v) || {} : {} }; }
	catch { SLOW = { at: Date.now(), map: SLOW.map || {} }; }
	return SLOW.map;
}
const saveSlow = (env, map) => env.DB.prepare("INSERT INTO config (k, v) VALUES ('slow-efforts', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(map)).run().catch(() => {});
async function tooSlow(env, model, effort) {
	const at = EFFORTS.indexOf(effort);
	const map = await slowEfforts(env);
	// cut off while thinking little, or again at the level it was lowered to: thinking isn't what takes too long, the
	// answer's length is (a gateway that waits for the whole answer gives up on a long one). Its thinking is put back for
	// everything else, and it's remembered as one that can't finish long work this way (a build goes to another model)
	if (at <= EFFORTS.indexOf("medium") || (map[model] && at <= EFFORTS.indexOf(map[model]))) {
		if (map[model]) { delete map[model]; await saveSlow(env, map); }
		await cantFinish(env, model);
		return;
	}
	const lower = EFFORTS[at - 1];
	if (map[model] && EFFORTS.indexOf(map[model]) <= EFFORTS.indexOf(lower)) return;
	map[model] = lower;
	await saveSlow(env, map);
}
// The models the gateway cuts off on long work (a whole app) even thinking little, kept for a few days (it may change):
// the site gives long work to another model first
let CANT = { at: 0, map: {} };
const CANT_DAYS = 3;
async function cantMap(env) {
	if (Date.now() - CANT.at < 300e3 && Date.now() >= CANT.at) return CANT.map;
	try { const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'cant-finish'").first(); CANT = { at: Date.now(), map: row ? JSON.parse(row.v) || {} : {} }; }
	catch { CANT = { at: Date.now(), map: CANT.map || {} }; }
	return CANT.map;
}
async function cantFinish(env, model) {
	const map = await cantMap(env);
	map[model] = now();
	await env.DB.prepare("INSERT INTO config (k, v) VALUES ('cant-finish', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(map)).run().catch(() => {});
}
// Models failing right now, kept for a quarter of an hour: { model: { n, at } }
let HEALTH = { at: 0, map: {} };
const HEALTH_FOR = 15 * 60e3;
async function healthMap(env) {
	if (Date.now() - HEALTH.at < 60e3 && Date.now() >= HEALTH.at) return HEALTH.map;
	try { const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'health'").first(); HEALTH = { at: Date.now(), map: row ? JSON.parse(row.v) || {} : {} }; }
	catch { HEALTH = { at: Date.now(), map: HEALTH.map || {} }; }
	return HEALTH.map;
}
const saveHealth = (env, map) => env.DB.prepare("INSERT INTO config (k, v) VALUES ('health', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(map)).run().catch(() => {});
async function modelFailed(env, model) {
	const map = await healthMap(env), h = map[model] && now() - map[model].at < HEALTH_FOR ? map[model] : { n: 0 };
	map[model] = { n: h.n + 1, at: now() };
	for (const k of Object.keys(map)) if (now() - map[k].at >= HEALTH_FOR) delete map[k];
	await saveHealth(env, map);
}
async function modelOk(env, model) {
	const map = await healthMap(env);
	if (!map[model]) return;
	delete map[model];
	await saveHealth(env, map);
}
// (more than five failing at once: the gateway is down, not those models; none is left out)
async function downList(env) {
	const map = await healthMap(env);
	const down = Object.keys(map).filter((m) => map[m].n >= 3 && now() - map[m].at < HEALTH_FOR);
	return down.length > 5 ? [] : down;
}
// How fast each model really is here, from the last week's calls (three at least): until its first word, and words a second
let SPEEDS = { at: 0, map: {} };
async function speedList(env) {
	if (Date.now() - SPEEDS.at < 600e3 && Date.now() >= SPEEDS.at) return SPEEDS.map;
	const map = {};
	try {
		const rows = (await env.DB.prepare("SELECT model, COUNT(*) AS n, AVG(CASE WHEN first_ms > 0 THEN first_ms END) AS first, SUM(CASE WHEN ms > first_ms AND first_ms > 0 THEN out_tok END) AS out, SUM(CASE WHEN ms > first_ms AND first_ms > 0 THEN ms - first_ms END) AS rest FROM usage WHERE created_at > ? AND ms > 0 AND out_tok > 0 GROUP BY model").bind(now() - 7 * 864e5).all()).results || [];
		for (const r of rows) if (r.n >= 3 && r.first > 0 && r.out > 0 && r.rest > 0) map[r.model] = { first: Math.round(r.first), tps: Math.round((r.out * 1000) / r.rest), n: r.n };
	} catch {}
	SPEEDS = { at: Date.now(), map };
	return map;
}
async function cantFinishList(env) { const map = await cantMap(env); return Object.keys(map).filter((m) => now() - map[m] < CANT_DAYS * 864e5); }

async function chat(req, env, ctx, user) {
	const c = await config(env);
	const b = await body(req);
	if (typeof b.model !== "string" || b.model.startsWith("openrouter/")) throw fail(400, "Pick a specific model.");
	// a reply written in parts (a model the gateway cuts off after about two minutes): this part's whole length, thinking
	// included, so it finishes in time (the site asks for the next part); never sent on to anyone
	const part = Math.floor(Number(b.chunk) || 0);
	delete b.chunk;
	// (a call made during deep work: only the gateway set for it; never sent on to anyone)
	const deep = !!b.deep;
	delete b.deep;
	// (a model the gateway has that OpenRouter doesn't list yet: the price to be safe with, until it does)
	const price = (await prices(env)).get(b.model) || (await freshModels(env)).find((x) => x.id === b.model);
	if (!price) throw fail(400, "That model isn't available.");
	if (spendable(user, c) < 1000) throw outOfCredits(user, c);
	// a live web search, when the site asks for one: the model's own search where the way allows it (how the search
	// leaderboard rates them), otherwise the server's own search results as numbered sources
	const plug = (Array.isArray(b.plugins) ? b.plugins : []).find((x) => x && x.id === "web");
	delete b.plugins;
	const web = plug ? { n: Math.max(1, Math.min(8, Number(plug.max_results) || 5)), query: plug.query || lastUserText(b.messages) } : null;
	await Promise.all(gateways(env).map(gatewayCatalog));
	let ways = routes(env, b.model, !!web, Array.isArray(b.tools) && b.tools.length > 0, price, orderFor(c, user.owner));
	// (the public only through the gateways set for it; the owner's demo through all of them)
	if (!user.owner && Array.isArray(c.publicGateways) && c.publicGateways.length) ways = ways.filter((w) => w.kind !== "gw" || c.publicGateways.includes(String(w.gw)));
	if (deep && c.deepGateway) ways = ways.filter((w) => w.kind === "gw" && w.gw === String(c.deepGateway));
	if (!ways.length) throw fail(503, deep ? "Deep work's models are busy right now." : "This server can't reach that model. Pick another, or try again later.");

	const mult = multiplier(price, c);
	// credits -> what the request may spend at list prices
	const toUsd = (mc) => (mc / 1000) * c.creditUsd / mult;
	// a hair under, so floating-point dust (1.0000000000000002) never rounds a whole extra unit up
	const toMc = (usd) => Math.ceil((usd * mult / c.creditUsd) * 1000 - 1e-6);
	const inTokens = inTokensOf(b);
	// a search is held at its worst case too: a few searches, and what they read
	const inUsd = inTokens * price.pin + (web ? web.n * 0.01 + 20000 * price.pin : 0);
	const room = toUsd(spendable(user, c)) - inUsd;
	if (room <= 0) throw fail(402, "Not enough credits for a message this long. Buy credits or start a new chat.");
	// (a level this model has been too slow at through the gateway: the one below it)
	const slowAt = (await slowEfforts(env))[b.model];
	if (slowAt && b.reasoning && EFFORTS.indexOf(b.reasoning.effort) > EFFORTS.indexOf(slowAt)) b.reasoning = { ...b.reasoning, effort: slowAt };
	const effort = b.reasoning && b.reasoning.effort;
	const thinkRoom = THINK_ROOM[effort] || 0;
	const started = now();
	// (when its first word came: how long a reply kept someone waiting, kept with what it cost)
	let firstAt = 0;
	let maxOut = Math.min((Number(b.max_tokens) || c.maxTokens) + thinkRoom, c.maxTokens + thinkRoom);
	if (price.mo > 0) maxOut = Math.min(maxOut, price.mo);
	if (part > 0) maxOut = Math.min(maxOut, Math.max(1024, part));
	if (price.pout > 0) maxOut = Math.min(maxOut, Math.floor(room / price.pout));
	if (maxOut < 64) throw fail(402, "Not enough credits for this model. Buy credits or choose a lower Quality.");

	// reserve the worst case first; only one statement can win, so parallel requests can't overspend
	const reserve = toMc(inUsd + maxOut * price.pout);
	const held = await take(env, user.id, reserve, c, !!user.owner);
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
		// (it answered: whatever was counted against it goes)
		if (way) await modelOk(env, b.model);
		await env.DB.batch([
			giveBack(env, user.id, held, charged),
			// (what it read, how much of that came from the cache, and what it wrote: whether the gateway passes the cache on)
			env.DB.prepare("INSERT INTO usage (user_id, model, cost_usd, charged_mc, created_at, in_tok, cached_tok, out_tok, ms, first_ms, write_tok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(user.id, b.model, real, charged, now(), Number(usage && usage.prompt_tokens) || 0, Number(usage && (usage.prompt_tokens_details?.cached_tokens || usage.cache_read_input_tokens)) || 0, Number(usage && usage.completion_tokens) || 0, now() - started, firstAt ? firstAt - started : 0, Number(usage && (usage.prompt_tokens_details?.cache_write_tokens || usage.cache_creation_input_tokens || usage.prompt_tokens_details?.cache_creation_input_tokens)) || 0),
			...freeSpend(env, held, charged, real),
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
						if (w.kind === "gw") GW_DOWN.delete(w.gw);
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
					if (res.status === 400 && w.kind === "gw" && w.lab === "anthropic" && !GW_NOCACHE.has(w.gw) && /cache/i.test(last.message)) {
						GW_NOCACHE.add(w.gw);
						continue;
					}
					if (res.status === 400 && !w.swapMax && w.kind !== "openrouter" && /max_(completion_)?tokens/i.test(last.message) && /support|instead|unrecogni[sz]ed|unknown|not allowed|invalid/i.test(last.message)) {
						w.swapMax = true;
						continue;
					}
					break;
				}
				if (w.kind === "gw" && [401, 402, 403].includes(res.status) && /\bkey\b|auth|balance|saldo|budget|credit|quota|insufficient|payment|unauthori[sz]ed/i.test(last.message || "")) GW_DOWN.set(w.gw, Date.now());
				// (full right now, "at capacity": the other gateway first for the next two minutes)
				else if (w.kind === "gw" && res.status === 503 && /overload|capacity/i.test(last.message || "")) GW_DOWN.set(w.gw, Date.now() - 480e3);
				const bad = res.status === 400 || res.status === 404;
				if (bad && !plain && effort && /effort|reasoning|thinking/i.test(last.message)) continue;
				// a spelling of the name it doesn't know: the next spelling; anything else: the next way
				if (bad && /model/i.test(last.message)) break;
				continue ask;
			}
		}
	}
	if (!r) {
		if (now() - started >= 80e3) await tooSlow(env, b.model, effort);
		await settle(null);
		// the owner's provider account refusing (no balance, a bad key) isn't the person's credits running out
		const status = !last ? 502 : [401, 402, 403].includes(last.status) ? 503 : last.status;
		// the gateway turning down Celestin's own key: no model will answer, so nobody is told to pick another. The owner
		// is told the gateway's own words and what to do (and emailed); everyone else, that it's being fixed
		const keyRefused = !!last && [401, 402, 403].includes(last.status) && /\bkey\b|auth|balance|budget|credit|quota|insufficient funds|payment|unauthori[sz]ed/i.test(last.message || "");
		// (the model itself failing, not the key or a crowd: counted, and three in a quarter hour leave it out for a while)
		if (!keyRefused && !(last && last.status === 429)) await modelFailed(env, b.model);
		if (keyRefused) await alertOwner(env, "gateway", "Your AI gateway turned down Celestin's key, so nobody can get answers right now. What it said: " + last.message + "\n\nWhat to do: open your gateway's dashboard (Flaz), go to the API keys, and unblock the key Celestin uses (or make a new key and send it to Claude). Check the wallet balance, and any budget cap on the key.");
		const message = !last ? "Couldn't reach the AI provider. Try again."
			: keyRefused ? (isOwner(user.id) ? "Your AI gateway turned down Celestin's key, so no model can answer: \"" + String(last.message).slice(0, 200) + "\". Open the gateway's dashboard (Flaz) → API keys, and unblock it or make a new one. Check the balance and any budget cap too." : "Celestin can't reach its AI models right now. It's being fixed: please try again in a little while.")
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
			// (nothing came back: the gateway doesn't bill it, so neither is anyone's credits)
			await settle(j && j.usage ? way : null, j && j.usage, 0);
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
		// (its own decoder: a character split across two chunks mustn't carry into another answer streaming meanwhile)
		const mine = new TextDecoder();
		const used = () => (conv ? conv.usage() : usage);
		// the person's side went away (weak wifi, a closed tab) while the model was still at it: not the model being slow
		let gone = false, upDone = false;
		const put = (t) => writer.write(enc.encode(t)).catch((e) => { if (!upDone) gone = true; throw e; });
		const end = async () => {
			if (ended) return;
			ended = true;
			upDone = true;
			// (a stream that ended with no word and no bill from the gateway, cut off by its time limit: nothing charged)
			const mc = await settle(outChars || used() ? way : null, used(), outChars);
			const tail = mc == null ? "" : "data: " + JSON.stringify({ id: "usage", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: b.model, choices: [], usage: shown(used() || {}, mc) }) + "\n\n";
			await put(tail + "data: [DONE]\n\n");
		};
		try {
			read: for (;;) {
				const { done, value } = await reader.read().catch((e) => { upDone = true; throw e; });
				if (done) { upDone = true; break; }
				buf += mine.decode(value, { stream: true });
				let out = "", i;
				while ((i = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, i).trim();
					buf = buf.slice(i + 1);
					// keep-alives keep the connection open while a model thinks or searches
					if (line.startsWith(":")) { out += ": keep-alive\n\n"; continue; }
					if (!line.startsWith("data:")) continue;
					const data = line.slice(5).trim();
					if (data === "[DONE]") {
						upDone = true;
						if (out) await put(out);
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
						const said = (x.choices?.[0]?.delta?.content || "").length;
						if (said && !firstAt) firstAt = now();
						outChars += said;
						out += "data: " + JSON.stringify(x) + "\n\n";
					}
					if (conv && conv.finished) {
						upDone = true;
						if (out) await put(out);
						await end();
						break read;
					}
				}
				if (out) await put(out);
			}
			await end();
		} catch {
			try { await reader.cancel(); } catch {}
		} finally {
			// cut off before a word came, after a long wait: too slow at this level (unless it was the person who went away)
			if (!gone && !outChars && !used() && now() - started >= 80e3) await tooSlow(env, b.model, effort);
			await settle(outChars || used() ? way : null, used(), outChars);
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
	const held = await take(env, user.id, mc, c, !!user.owner);
	if (!held) {
		if (spendable(user, c) < 1000) throw outOfCredits(user, c);
		throw fail(402, "You don't have enough credits for this right now. A credit pack keeps you going, or pick a cheaper quality.");
	}
	return held;
}
async function charge(env, userId, model, held, usd, mt) {
	const charged = mt.toMc(usd);
	await env.DB.batch([
		giveBack(env, userId, held, charged),
		env.DB.prepare("INSERT INTO usage (user_id, model, cost_usd, charged_mc, created_at) VALUES (?, ?, ?, ?, ?)").bind(userId, model, usd, charged, now()),
		...freeSpend(env, held, charged, usd),
	]);
	return charged;
}
const orHeaders = (env) => ({ Authorization: "Bearer " + env.OPENROUTER_KEY, "Content-Type": "application/json", "HTTP-Referer": env.SITE_URL || "https://andromeda.app", "X-Title": "Celestin" });
// the studio's models are WaveSpeed's (WAVESPEED_KEY) or OpenRouter's
async function studioOpen(env) {
	if (!env.OPENROUTER_KEY && !wsOn(env) && !(await gwMedia(env)).length) throw fail(503, "Pictures, videos and voice aren't on this server yet.");
}
// A gateway's own picture and video models (MarkasAI's), under the ids the site's model lists use and the names the
// leaderboards give them (as WaveSpeed's are)
const GW_MEDIA = {
	"gpt-image-2": ["openai/gpt-image-2", "GPT Image 2"],
	"nano-banana-2": ["google/nano-banana-2", "Gemini 3.1 Flash Image"],
	"nano-banana-pro": ["google/nano-banana-pro", "Gemini 3 Pro Image"],
	"nano-banana": ["google/nano-banana", "Gemini 2.5 Flash Image"],
	"grok-imagine": ["x-ai/grok-imagine-image", "Grok Imagine Image"],
	"seedance-2.0": ["bytedance/seedance-2.0", "Seedance 2.0"],
};
// what a gateway's model makes: its list's own type (MarkasAI's: image, video, tts), or, when the list gives no types
// (LiteLLM's), what its name says; speech-to-text, embeddings and the like are none of these
function mediaKindOf(m, typed) {
	const t = String(m.type || "").toLowerCase();
	if (typed) return t === "image" ? "image" : t === "video" ? "video" : /^(tts|speech|audio_speech|voice)$/.test(t) ? "tts" : null;
	const id = String(m.id || "").toLowerCase();
	if (/whisper|transcri|(^|[-_/])stt([-_/]|$)|embed|moderation|realtime/.test(id)) return null;
	if (/(^|[-_/.])tts([-_/.]|$)|text-to-speech|eleven|(^|[-_/])speech-\d/.test(id)) return "tts";
	if (/gpt-image|imagen|nano-banana|flux|seedream|dall-?e|grok-imagine|recraft|ideogram|(^|[-_/])image([-_/]|$)/.test(id)) return "image";
	if (/veo|sora|kling|seedance|(^|[-_/])wan-?\d|hailuo|minimax-h\d|gemini-omni|runway|(^|[-_/])video([-_/]|$)/.test(id)) return "video";
	return null;
}
// a model's name the way the site's lists name it ("eleven_v4" → "elevenlabs/eleven-v4", "sora-2" → "openai/sora-2")
const GW_LAB = [[/eleven/, "elevenlabs"], [/^(gemini|imagen|veo|lyria|nano-banana)/, "google"], [/^(gpt|sora|dall|tts-1|o\d)/, "openai"], [/^grok/, "x-ai"], [/^(seedance|seedream)/, "bytedance"], [/^kling/, "kwaivgi"], [/^wan/, "alibaba"], [/^(minimax|hailuo|speech-)/, "minimax"], [/^flux/, "black-forest-labs"], [/^recraft/, "recraft"], [/^ideogram/, "ideogram"], [/^runway/, "runway"]];
function siteIdOf(id) {
	const x = String(id).toLowerCase().replace(/_/g, "-");
	if (x.includes("/")) return x.replace(/^xai\//, "x-ai/");
	const lab = (GW_LAB.find(([re]) => re.test(x)) || [])[1];
	return lab ? lab + "/" + x : null;
}
const prettyOf = (id) => String(id).replace(/^.*\//, "").replace(/[-_]+/g, " ").replace(/\b([a-z])/g, (m) => m.toUpperCase());
// prices a list doesn't give: each kind at about what its makers charge (held generously, then charged the same)
const guessImageUsd = (id) => (/pro|ultra|hd/i.test(id) ? 0.13 : 0.05);
const guessVideoUsdPerSec = (id) => (/sora.*pro/i.test(id) ? 0.3 : /veo.*fast|veo.*lite/i.test(id) ? 0.15 : /veo/i.test(id) ? 0.4 : /sora|kling|wan|seedance|hailuo|minimax/i.test(id) ? 0.12 : 0.3);
const guessTtsUsdPerChar = (id) => (/eleven/i.test(id) ? 0.0001 : 0.00002);
// the voices a voice model takes, by its maker (ElevenLabs by name, as the site casts them)
const voicesOf = (id) => (/eleven/i.test(id) ? WS_ELEVEN : /gemini/i.test(id) ? ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"] : /gpt|tts-1|openai/i.test(id) ? ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"] : []);
// (only: the gateways this person may use; the public never reaches MarkasAI, the owner, Nov 7)
async function gwMedia(env, only) {
	const gws = gateways(env, only), out = [];
	if (!gws.length) return out;
	const cats = await Promise.all(gws.map(gatewayCatalog));
	for (let i = 0; i < gws.length; i++) {
		const idr = await idrPerUsd(gws[i]);
		for (const m of cats[i].media || []) {
			const [site, name] = GW_MEDIA[m.id] || [siteIdOf(m.id) || "gw" + gws[i].n + "/" + m.id, prettyOf(m.id)];
			if (!out.some((x) => x.site === site)) out.push({ ...m, site, name, g: gws[i], idr });
		}
	}
	return out;
}
async function gwMediaHas(env, model, kind, only) { return (await gwMedia(env, only)).find((m) => m.site === String(model || "") && m.type === kind) || null; }
// what a picture costs there, in dollars: its unit price, or the image tokens a picture of that quality takes
function gwImageUsd(m, quality) {
	const p = m.pricing;
	if (p.per_unit === "image" || p.unit === "image") return Number(p.unit_price || p.pricePerImage || 0) / m.idr || guessImageUsd(m.id);
	const per = (v) => Number(v || 0) / m.idr / (Number(p.per_tokens) || 1e6);
	const tokens = /gpt/i.test(m.id) ? { low: 272, medium: 1056, high: 4160 }[quality] || 1056 : 1290;
	return per(p.image_output || p.output) * tokens + per(p.input) * 300 || guessImageUsd(m.id);
}
const gwVideoUsdPerSec = (m, res) => { const r = m.pricing.resolutions || {}; return Number(r[res] || r["720P"] || Object.values(r)[0] || 0) / m.idr || guessVideoUsdPerSec(m.id); };
const gwTtsUsdPerChar = (m) => { const p = m.pricing; return (p.per_unit === "character" ? Number(p.unit_price || 0) / m.idr : 0) || guessTtsUsdPerChar(m.id); };
// in the shapes the site reads the studio's models in
function gwMediaCatalog(list) {
	const out = { image: [], video: [], speech: [], music: [] };
	for (const m of list) {
		if (m.type === "image") out.image.push({ id: m.site, name: m.name, supported_parameters: { aspect_ratio: { values: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"] }, resolution: { values: ["1K"] }, input_references: { max: 0 } }, price: gwImageUsd(m, "medium") });
		else if (m.type === "tts") out.speech.push({ id: m.site, name: m.name, supported_voices: m.voices || voicesOf(m.id), pricing: { prompt: gwTtsUsdPerChar(m) } });
		else if (m.type === "video") {
			const listed = Object.keys(m.pricing.resolutions || {}).map((r) => r.toLowerCase()).filter((r) => /^(480p|720p|1080p)$/.test(r));
			const res = listed.length ? listed : ["720p"];
			const skus = {};
			for (const r of res) skus["duration_seconds_" + r] = gwVideoUsdPerSec(m, r.toUpperCase());
			out.video.push({ id: m.site, name: m.name, supported_durations: Array.from({ length: Math.max(1, m.maxSecs - 2) }, (_, k) => k + 3).filter((d) => d <= m.maxSecs), supported_resolutions: res, supported_aspect_ratios: ["16:9", "9:16", "1:1"], supported_frame_images: [], generate_audio: true, pricing_skus: skus, from_words: true });
		}
	}
	return out;
}
// a picture from a gateway: asked at the size nearest the shape wanted, paid for by what it reports (or the estimate)
async function gwImage(env, user, m, b, c, mt) {
	const n = Math.max(1, Math.min(m.maxN, Number(b.n) || 1));
	const r0 = ratioOf(b.aspect_ratio || "1:1") || 1;
	const size = r0 > 1.15 ? "1536x1024" : r0 < 0.87 ? "1024x1536" : "1024x1024";
	const quality = /4k|2k/i.test(String(b.resolution || "")) ? "high" : "medium";
	const each = gwImageUsd(m, quality);
	const held = await hold(env, user, mt.toMc(each * n * 1.3), c);
	try {
		const r = await fetch(m.g.base + "/images/generations", { method: "POST", headers: { Authorization: "Bearer " + m.g.key, "Content-Type": "application/json" }, body: JSON.stringify({ model: m.id, prompt: String(b.prompt || "").slice(0, 4000), n, size, ...(m.pricing.per_tokens ? { quality } : {}) }), signal: AbortSignal.timeout(180e3) });
		const j = await r.json().catch(() => ({}));
		if (!r.ok || !Array.isArray(j.data) || !j.data.length) throw fail([401, 402, 403].includes(r.status) ? 503 : r.status === 400 ? 400 : 502, j.error?.message || "The image couldn't be made. Try again.");
		// (as data, or, from some gateways, as a link to fetch)
		const data = (await Promise.all(j.data.map(async (x) => { if (x && !x.b64_json && typeof x.url === "string") { try { const f = await fetch(x.url); if (f.ok) return { b64_json: toB64(await f.arrayBuffer()) }; } catch {} } return x; }))).filter((x) => x && x.b64_json).map((x) => ({ b64_json: x.b64_json, media_type: x.b64_json.startsWith("/9j/") ? "image/jpeg" : x.b64_json.startsWith("UklGR") ? "image/webp" : "image/png" }));
		if (!data.length) throw fail(502, "The image came back empty. Try again.");
		// what it really cost: the tokens it reports, else the estimate
		const u = j.usage || {}, p = m.pricing, per = (v) => Number(v || 0) / m.idr / (Number(p.per_tokens) || 1e6);
		const outTok = Number(u.output_tokens || u.completion_tokens) || 0;
		const told = p.per_tokens && outTok ? per(p.input) * (Number(u.input_tokens || u.prompt_tokens) || 0) + per(p.image_output || p.output) * outTok : 0;
		const charged = await charge(env, user.id, b.model, held, told > 0 ? told : each * data.length, mt);
		return json({ data, usage: { cost: (charged / 1000) * c.creditUsd, credits: charged / 1000 } });
	} catch (e) {
		await charge(env, user.id, b.model, held, 0, mt);
		throw e.status ? e : fail(502, "The image couldn't be made. Try again.");
	}
}
async function gwSpeech(env, user, m, text, b, c, mt) {
	const pieces = [];
	let rest = text;
	while (rest.length > 4000) {
		const cut = Math.max(rest.lastIndexOf(". ", 4000), rest.lastIndexOf("\n", 4000), rest.lastIndexOf(" ", 4000));
		const at = cut > 2000 ? cut + 1 : 4000;
		pieces.push(rest.slice(0, at).trim());
		rest = rest.slice(at);
	}
	if (rest.trim()) pieces.push(rest.trim());
	const usd = Math.max(0.002, text.length * gwTtsUsdPerChar(m));
	const held = await hold(env, user, mt.toMc(usd * 1.2), c);
	try {
		const parts = [];
		let type = "audio/mpeg";
		const voice = String(b.voice || (m.voices || voicesOf(m.id))[0] || "alloy");
		for (const input of pieces) {
			const r = await fetch(m.g.base + "/audio/speech", { method: "POST", headers: { Authorization: "Bearer " + m.g.key, "Content-Type": "application/json" }, body: JSON.stringify({ model: m.id, input, voice, response_format: "mp3" }), signal: AbortSignal.timeout(120e3) });
			if (!r.ok) { let msg = r.statusText; try { msg = (await r.json()).error?.message || msg; } catch {} throw fail([401, 402, 403].includes(r.status) ? 503 : r.status === 400 ? 400 : 502, msg || "The voice couldn't be made."); }
			type = (r.headers.get("Content-Type") || type).split(";")[0];
			parts.push(new Uint8Array(await r.arrayBuffer()));
		}
		const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
		let o = 0;
		for (const p of parts) { all.set(p, o); o += p.length; }
		const charged = await charge(env, user.id, b.model, held, usd, mt);
		return new Response(all, { headers: { "Content-Type": /^audio\//.test(type) ? type : "audio/mpeg", "X-Credits": String(charged / 1000), "Access-Control-Expose-Headers": "X-Credits" } });
	} catch (e) {
		await charge(env, user.id, b.model, held, 0, mt);
		throw e.status ? e : fail(502, "The voice couldn't be made. Try again.");
	}
}
// A video from a gateway that starts it as a job (OpenAI's /videos, which LiteLLM serves): started here, checked on by the
// site, paid for once it's finished by its seconds (nothing if it fails); which gateway and job ride in the job's name
const gvJob = (jobId) => { try { const g = JSON.parse(unb64url(jobId.slice(3))); return g && g.id ? g : null; } catch { return null; } };
async function gwVideoJob(env, user, m, b, c, mt) {
	const secs = Math.max(1, Math.min(m.maxSecs, Math.round(Number(b.duration) || 8)));
	const perSec = gwVideoUsdPerSec(m, String(b.resolution || "720p").toUpperCase());
	const reserve = mt.toMc(perSec * secs * 1.05);
	const held = await hold(env, user, reserve, c);
	let j, r;
	try {
		const size = /9:16/.test(String(b.aspect_ratio || "")) ? "720x1280" : "1280x720";
		r = await fetch(m.g.base + "/videos", { method: "POST", headers: { Authorization: "Bearer " + m.g.key, "Content-Type": "application/json" }, body: JSON.stringify({ model: m.id, prompt: String(b.prompt || "").slice(0, 4000), seconds: String(secs), size }), signal: AbortSignal.timeout(60e3) });
		j = await r.json().catch(() => ({}));
		if (!r.ok || !j.id) throw fail([401, 402, 403].includes(r.status) ? 503 : r.status === 400 ? 400 : 502, j.error?.message || "The video couldn't be started.");
	} catch (e) {
		await charge(env, user.id, b.model, held, 0, mt);
		throw e.status ? e : fail(502, "The video couldn't be started. Try again.");
	}
	const id = "gv-" + b64url(JSON.stringify({ g: m.g.n, id: j.id, s: secs, p: perSec }));
	await env.DB.prepare("INSERT INTO jobs (id, user_id, model, reserve_mc, from_free, settled, created_at, owner) VALUES (?, ?, ?, ?, ?, 0, ?, ?)").bind(id, user.id, b.model, reserve, held.fromFree, now(), held.owner ? 1 : 0).run();
	return json({ id, status: "pending" }, 202);
}
async function gwVideoPoll(env, user, job, c, mt) {
	const g = gvJob(job.id), gw = g && gateways(env).find((x) => x.n === String(g.g));
	if (!gw) throw fail(404, "No such video.");
	const r = await fetch(gw.base + "/videos/" + encodeURIComponent(g.id), { headers: { Authorization: "Bearer " + gw.key } });
	const d = await r.json().catch(() => ({}));
	const done = d.status === "completed", gone = /failed|cancelled|expired/.test(String(d.status || "")) || r.status === 404;
	let usage = { cost: 0 };
	if ((done || gone) && !job.settled) {
		const mine = await env.DB.prepare("UPDATE jobs SET settled = 1 WHERE id = ? AND settled = 0").bind(job.id).run();
		if (mine.meta && mine.meta.changes) {
			const pl = planOf(user, c), held = { fromFree: job.from_free || 0, fromPaid: job.reserve_mc - (job.from_free || 0), free: !pl.paid, owner: !!job.owner, month: !!(pl.paid && pl.month && job.from_free) };
			const charged = await charge(env, user.id, job.model, held, done ? Number(g.s) * Number(g.p) : 0, mt);
			usage = { cost: (charged / 1000) * c.creditUsd, credits: charged / 1000 };
		}
	}
	return json({ id: job.id, status: done ? "completed" : gone ? "failed" : "in_progress", unsigned_urls: done ? ["/api/videos/" + job.id + "/content?index=0"] : [], usage, error: gone ? (d.error && d.error.message) || "The video model couldn't make this shot." : undefined });
}
// A video from a gateway that makes it while the request waits (minutes, as MarkasAI does): the site is answered at once
// with a body that stays open (a space every 15 s keeps the connection alive) and ends with the finished job, which is
// paid for by the seconds made. Its links ride in the job's own name, so it's checked on and fetched like any other
const b64url = (x) => btoa(unescape(encodeURIComponent(x))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (x) => decodeURIComponent(escape(atob(String(x).replace(/-/g, "+").replace(/_/g, "/"))));
const gwJob = (jobId) => { try { const g = JSON.parse(unb64url(jobId.slice(3))); return Array.isArray(g.u) ? g : null; } catch { return null; } };
async function gwVideo(env, user, m, b, c, mt) {
	const secs = Math.max(1, Math.min(m.maxSecs, Math.round(Number(b.duration) || 5)));
	const want = String(b.resolution || "720p").toUpperCase();
	const res = (m.pricing.resolutions || {})[want] ? want : "720P";
	const perSec = gwVideoUsdPerSec(m, res);
	const reserve = mt.toMc(perSec * secs * 1.05);
	const held = await hold(env, user, reserve, c);
	const { readable, writable } = new TransformStream();
	const w = writable.getWriter();
	const ping = setInterval(() => { w.write(enc.encode(" ")).catch(() => {}); }, 15000);
	(async () => {
		let out;
		try {
			// (full right now: asked again when it says to, a few times, while the answer stays open)
			let r, j;
			for (let again = 0; ; again++) {
				r = await fetch(m.g.base + "/videos/generations", { method: "POST", headers: { Authorization: "Bearer " + m.g.key, "Content-Type": "application/json" }, body: JSON.stringify({ model: m.id, prompt: String(b.prompt || "").slice(0, 4000), duration_seconds: secs, resolution: res, ...(b.aspect_ratio ? { aspect_ratio: String(b.aspect_ratio) } : {}), audio: b.generate_audio !== false }), signal: AbortSignal.timeout(14 * 60e3) });
				j = await r.json().catch(() => ({}));
				if (r.status !== 503 || again >= 3 || !/overload|capacity/i.test(JSON.stringify(j.error || ""))) break;
				await new Promise((res) => setTimeout(res, Math.min(20, Math.max(5, Number(r.headers.get("Retry-After")) || 15)) * 1000));
			}
			const urls = (Array.isArray(j.videos) ? j.videos : []).map((v) => v && v.url).filter((u) => typeof u === "string");
			if (!r.ok || !urls.length) throw fail([401, 402, 403].includes(r.status) ? 503 : r.status === 400 ? 400 : 502, (r.status === 503 ? "The video model is busy right now (it said: " + (j.error?.message || "at capacity") + "). Try again in a few minutes." : j.error?.message || "The video model couldn't make this shot."));
			const made = Math.min(secs, Number(j.duration_seconds) || secs);
			const charged = await charge(env, user.id, b.model, held, perSec * made, mt);
			const id = "gw-" + b64url(JSON.stringify({ u: urls, k: charged }));
			await env.DB.prepare("INSERT INTO jobs (id, user_id, model, reserve_mc, from_free, settled, created_at, owner) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").bind(id, user.id, b.model, reserve, held.fromFree, now(), held.owner ? 1 : 0).run();
			out = { id, status: "completed" };
		} catch (e) {
			await charge(env, user.id, b.model, held, 0, mt).catch(() => {});
			out = { error: { message: String((e && e.message) || "The video couldn't be made."), code: (e && e.status) || 502 } };
		}
		clearInterval(ping);
		await w.write(enc.encode(JSON.stringify(out))).catch(() => {});
		await w.close().catch(() => {});
	})();
	return new Response(readable, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
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
	await studioOpen(env);
	const c = await config(env), mt = media(c);
	const b = await body(req);
	const gv = await gwMediaHas(env, b.model, "video", user.owner ? undefined : c.publicGateways);
	// (one made while the request waits, as MarkasAI does; or one started as a job, as LiteLLM's /videos does)
	if (gv) return /\/videos\/generations/.test(gv.endpoint) || gv.pricing.resolutions ? gwVideo(env, user, gv, b, c, mt) : gwVideoJob(env, user, gv, b, c, mt);
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
	await env.DB.prepare("INSERT INTO jobs (id, user_id, model, reserve_mc, from_free, settled, created_at, owner) VALUES (?, ?, ?, ?, ?, 0, ?, ?)").bind(j.id, user.id, b.model, reserve, held.fromFree, now(), held.owner ? 1 : 0).run();
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
	if (jobId.startsWith("gv-")) return gwVideoPoll(env, user, job, c, mt);
	// (a gateway's video: finished before it was handed back; its links are in its name)
	if (jobId.startsWith("gw-")) {
		const g = gwJob(jobId);
		if (!g) throw fail(404, "No such video.");
		return json({ id: jobId, status: "completed", unsigned_urls: g.u.map((_, i) => "/api/videos/" + jobId + "/content?index=" + i), usage: { cost: ((Number(g.k) || 0) / 1000) * c.creditUsd, credits: (Number(g.k) || 0) / 1000 } });
	}
	const r = await fetch(orBase(env) + "/videos/" + jobId, { headers: orHeaders(env) });
	const j = await r.json().catch(() => ({}));
	const status = j.status || (r.status === 404 ? "expired" : "in_progress");
	const done = status === "completed", gone = /failed|cancelled|expired/.test(status);
	if ((done || gone) && !job.settled) {
		// only one poll gets to settle it
		const mine = await env.DB.prepare("UPDATE jobs SET settled = 1 WHERE id = ? AND settled = 0").bind(jobId).run();
		if (mine.meta && mine.meta.changes) {
			const usd = done ? Number(j.usage?.cost) : 0;
			const pl = planOf(user, c), held = { fromFree: job.from_free || 0, fromPaid: job.reserve_mc - (job.from_free || 0), free: !pl.paid, owner: !!job.owner, month: !!(pl.paid && pl.month && job.from_free) };
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
	if (jobId.startsWith("gv-")) {
		const g = gvJob(jobId), gw = g && gateways(env).find((x) => x.n === String(g.g));
		if (!gw) throw fail(404, "That video isn't ready or has expired.");
		const r = await fetch(gw.base + "/videos/" + encodeURIComponent(g.id) + "/content", { headers: { Authorization: "Bearer " + gw.key } });
		if (!r.ok) throw fail(r.status === 404 ? 404 : 502, "That video isn't ready or has expired.");
		return new Response(r.body, { headers: { "Content-Type": r.headers.get("Content-Type") || "video/mp4", "Cache-Control": "private, max-age=3600" } });
	}
	if (jobId.startsWith("gw-")) {
		const u = (gwJob(jobId) || { u: [] }).u[index];
		if (!u) throw fail(404, "That video isn't ready or has expired.");
		const r = await fetch(u);
		if (!r.ok) throw fail(r.status === 404 || r.status === 403 ? 404 : 502, "That video isn't ready or has expired.");
		return new Response(r.body, { headers: { "Content-Type": mediaType(r, u, "video/mp4"), "Cache-Control": "private, max-age=3600" } });
	}
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
	await studioOpen(env);
	const c = await config(env), mt = media(c);
	const b = await body(req);
	if (typeof b.model !== "string") throw fail(400, "Pick an image model.");
	const gm = await gwMediaHas(env, b.model, "image", user.owner ? undefined : c.publicGateways);
	if (gm) return gwImage(env, user, gm, b, c, mt);
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
	await studioOpen(env);
	const c = await config(env), mt = media(c);
	const b = await body(req);
	const text = Array.isArray(b.input) ? b.input.map((x) => x.text || "").join(" ") : String(b.input || "");
	if (!text.trim() || text.length > 10000) throw fail(400, "Give the voice between 1 and 10,000 characters.");
	const gs = await gwMediaHas(env, b.model, "tts", user.owner ? undefined : c.publicGateways);
	if (gs) return gwSpeech(env, user, gs, text, b, c, mt);
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
	await studioOpen(env);
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
	await env.DB.prepare("INSERT INTO jobs (id, user_id, model, reserve_mc, from_free, settled, created_at, owner) VALUES (?, ?, ?, ?, ?, 0, ?, ?)").bind(id, user.id, b.model, reserve, held.fromFree, now(), held.owner ? 1 : 0).run();
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
			const pl = planOf(user, c), held = { fromFree: job.from_free || 0, fromPaid: job.reserve_mc - (job.from_free || 0), free: !pl.paid, owner: !!job.owner, month: !!(pl.paid && pl.month && job.from_free) };
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

// a live web search for Celestin working on its own (Tavily or Brave, when the server has a key for one)
async function toolSearch(req, env, user) {
	const b = await body(req);
	const q = String(b.query || "").trim();
	if (!q) throw fail(400, "Search for what?");
	if (!env.TAVILY_KEY && !env.BRAVE_KEY && !gateways(env).length && !env.OPENROUTER_KEY) throw fail(503, "Web search isn't set up on this server yet. Read pages directly with fetch_url instead.");
	return json({ results: await searchFor(env, user, q, Math.max(1, Math.min(10, Number(b.n) || 6))) });
}
async function toolFetch(req, env) {
	const b = await body(req);
	let u;
	try { u = new URL(String(b.url || "")); } catch { throw fail(400, "That isn't a link."); }
	if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/.test(u.hostname)) throw fail(400, "That link can't be opened.");
	let r;
	try {
		r = await fetch(u.toString(), { headers: { "User-Agent": "Mozilla/5.0 (compatible; Celestin/1.0)", Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
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

// ------------------------------------------------------------------ Celestin's own measurements
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
// is an ordinary request made for the person (their credits, the models Celestin picked for it, a live web search),
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
const taskOut = (t) => ({ id: t.id, title: t.title, prompt: t.prompt, every: t.every, minute: t.minute, dow: t.dow, tz: t.tz, web: !!t.web, next_at: t.next_at, last_at: t.last_at, active: !!t.active, member: t.member || null });
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
		member: /^(researcher|builder|designer|writer|analyst|reviewer)$/.test(String(b.member || "")) ? String(b.member) : null,
	};
	t.next_at = nextRun(t, now());
	if (/^[a-f0-9]{24}$/.test(String(b.id || ""))) {
		const r = await env.DB.prepare("UPDATE tasks SET title = ?, prompt = ?, every = ?, minute = ?, dow = ?, tz = ?, web = ?, models = ?, active = ?, next_at = ? WHERE id = ? AND user_id = ?")
			.bind(t.title, t.prompt, t.every, t.minute, t.dow, t.tz, t.web, t.models, t.active, t.next_at, b.id, user.id).run();
		if (r.meta && r.meta.changes) { const k = await env.DB.prepare("SELECT member FROM tasks WHERE id = ?").bind(b.id).first(); return json({ task: taskOut({ ...t, id: b.id, member: k && k.member }) }); }
	}
	const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?").bind(user.id).first();
	if (n && n.n >= 20) throw fail(429, "You have 20 tasks already: delete one to add another.");
	const tid = id();
	await env.DB.prepare("INSERT INTO tasks (id, user_id, title, prompt, every, minute, dow, tz, web, models, active, next_at, created_at, member) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(tid, user.id, t.title, t.prompt, t.every, t.minute, t.dow, t.tz, t.web, t.models, t.active, t.next_at, now(), t.member).run();
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
// one run: the request as the person would send it, the models tried in the order Celestin picked them
async function runTask(env, ctx, t) {
	const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(t.user_id).first();
	if (!row) return null;
	const user = await readyUser(env, row, await config(env));
	let models = [];
	try { models = JSON.parse(t.models || "[]"); } catch {}
	if (!models.length) models = ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol", "google/gemini-3.8-flash"];
	const when = new Date(now() + (Number(t.tz) || 0) * 60e3).toISOString().slice(0, 16).replace("T", " ");
	const messages = [
		{ role: "system", content: "You are Celestin. This is a task the user set up to run by itself on a schedule, and it's running now: " + when + " in their time. Do it completely, as a finished message to them: what matters first, no preamble, and no questions back (they aren't here to answer). Use Markdown." },
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
	// a month of a plan, or a pack of credits (a plan's payment is "plan:<id>" and carries no credits of its own)
	const plan = b.plan ? c.plans.find((p) => p.id === b.plan) : null;
	const pack = plan ? null : c.packs.find((p) => p.id === b.pack);
	const item = plan || pack;
	if (!item || !item.prices || !item.prices.IDR) throw fail(400, b.plan ? "Pick a plan." : "Pick a pack.");
	const reference = String(b.reference || "").trim().slice(0, 120);
	if (reference.length < 2) throw fail(400, "Write the name on your payment so it can be matched.");
	const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND status = 'pending'").bind(user.id).first();
	if (open && open.n >= 3) throw fail(429, "You already have payments waiting to be confirmed.");
	const pay = { id: id(), user_id: user.id, method: "qris", pack: plan ? "plan:" + plan.id : pack.id, amount: item.prices.IDR, currency: "IDR", credits_mc: plan ? 0 : (pack.credits + (pack.bonus || 0)) * 1000, status: "pending", note: reference };
	await env.DB.prepare("INSERT INTO payments (id, user_id, method, pack, amount, currency, credits_mc, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(pay.id, pay.user_id, pay.method, pay.pack, pay.amount, pay.currency, pay.credits_mc, pay.status, pay.note, now()).run();
	return json({ ok: true, payment: { ...pay, credits: pay.credits_mc / 1000 } });
}

async function addCredits(env, paymentId) {
	const p = await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(paymentId).first();
	if (!p) return false;
	const ok = await env.DB.prepare("UPDATE payments SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending'").bind(now(), paymentId).run();
	if (!ok.meta || !ok.meta.changes) return false;
	// a plan's month starts (or is added to the one running); a pack's credits are added
	if (/^plan:/.test(p.pack || "")) {
		const plan = (await config(env)).plans.find((x) => "plan:" + x.id === p.pack);
		if (plan) return startPlan(env, p.user_id, plan);
	}
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
	if (!user) throw fail(400, "Order has no Celestin account attached.");
	const ref = "lemon:" + ev.data.id;
	if (await env.DB.prepare("SELECT id FROM payments WHERE ref = ?").bind(ref).first()) return json({ ok: true, duplicate: true });
	const c = await config(env);
	const variant = String(a.first_order_item?.variant_id || "");
	const plan = c.plans.find((p) => p.lemonVariant && String(p.lemonVariant) === variant);
	const pack = plan ? null : c.packs.find((p) => p.lemonVariant && String(p.lemonVariant) === variant);
	const credits = plan ? 0 : pack ? pack.credits + (pack.bonus || 0) : Math.floor(((Number(a.total_usd) || 0) / 100) / c.creditUsd);
	const pid = id();
	await env.DB.prepare("INSERT INTO payments (id, user_id, method, pack, amount, currency, credits_mc, status, ref, created_at) VALUES (?, ?, 'card', ?, ?, ?, ?, 'pending', ?, ?)")
		.bind(pid, user.id, plan ? "plan:" + plan.id : pack ? pack.id : null, (Number(a.total) || 0) / 100, a.currency || "USD", credits * 1000, ref, now()).run();
	await addCredits(env, pid);
	return json({ ok: true });
}

// ------------------------------------------------------------------ support: help when people need it
// A request gets a number at once. The owner gets an email with everything needed to answer (and a link that opens a
// reply to the customer); the customer gets a copy with the number, and can answer that email to add more. Signed in or
// not (not being able to sign in is a common reason to write), kept from flooding by a few an hour from one place.
const SUPPORT_KINDS = ["Payments and refunds", "Credits and packs", "Signing in", "Something isn't working", "An answer was wrong", "Privacy and my data", "Other"];
async function optionalUser(req, env) {
	try { return bearer(req) ? await authUser(req, env) : null; } catch { return null; }
}
const escHtml = (t) => String(t || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
async function openTicket(env, { user, email, category, message, details, ip }) {
	const c = await config(env);
	let tid = "";
	for (let k = 0; k < 5 && !tid; k++) {
		const n = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
		const r = await env.DB.prepare("INSERT OR IGNORE INTO support (id, user_id, email, category, subject, message, details, status, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
			.bind(n, user ? user.id : null, email, category, message.split("\n")[0].slice(0, 80), message, details || null, ip || null, now()).run();
		if (r.meta && r.meta.changes) tid = n;
	}
	if (!tid) throw fail(500, "Couldn't save that just now. Try again.");
	const tag = "[Celestin #" + tid + "]";
	let mailed = false;
	if (mailOn(env)) {
		try {
			const reply = "mailto:" + encodeURIComponent(email) + "?subject=" + encodeURIComponent("Re: " + tag + " " + category) + "&body=" + encodeURIComponent("Hi,\n\n\n\nCelestin support\n\n> " + message.slice(0, 600).replace(/\n/g, "\n> "));
			if (c.support) await sendMail(env, c.support, tag + " " + category + ": " + message.slice(0, 60).replace(/\s+/g, " "),
				"From: " + email + (user ? " (account " + user.id + ")" : " (not signed in)") + "\nAbout: " + category + "\n\n" + message + (details ? "\n\nDetails:\n" + details : "") + "\n\nReply: " + reply,
				'<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111;line-height:1.5"><p><b>From:</b> ' + escHtml(email) + (user ? " (account " + user.id + ")" : " (not signed in)") + "<br><b>About:</b> " + escHtml(category) + '</p><p style="white-space:pre-wrap;border-left:3px solid #ddd;padding-left:12px">' + escHtml(message) + "</p>" + (details ? '<p style="color:#555;white-space:pre-wrap;font-size:13px"><b>Details:</b>\n' + escHtml(details) + "</p>" : "") + '<p><a href="' + escHtml(reply) + '" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Reply to the customer</a></p></div>');
			await sendMail(env, email, "We got your message " + tag, "Thanks for writing. Your request number is #" + tid + ".\n\nWe read every message ourselves and usually answer within 24 hours. To add anything, reply to this email.\n\nWhat you wrote:\n" + message + "\n\nCelestin support",
				'<div style="font-family:system-ui,sans-serif;font-size:15px;color:#111;line-height:1.55"><p>Thanks for writing. Your request number is <b>#' + tid + "</b>.</p><p>We read every message ourselves and usually answer within 24 hours. To add anything, reply to this email.</p><p style=\"color:#555;white-space:pre-wrap;border-left:3px solid #ddd;padding-left:12px\">" + escHtml(message) + "</p><p>Celestin support</p></div>");
			mailed = true;
		} catch {}
	}
	return { id: tid, mailed };
}
async function supportNew(req, env) {
	const b = await body(req);
	const user = await optionalUser(req, env);
	// (a box people can't see, that only robots fill in)
	if (b.website) return json({ ok: true, id: "000000" });
	const email = user ? user.email : cleanEmail(b.email);
	const category = SUPPORT_KINDS.includes(b.category) ? b.category : "Other";
	const message = String(b.message || "").trim().slice(0, 5000);
	if (message.length < 10) throw fail(400, "Tell us a little more, so we can help (at least a sentence).");
	const details = b.details ? String(typeof b.details === "string" ? b.details : JSON.stringify(b.details, null, 1)).slice(0, 4000) : "";
	const ip = await sha256hex("ip:" + (req.headers.get("CF-Connecting-IP") || "?"));
	const hour = await env.DB.prepare("SELECT COUNT(*) AS n FROM support WHERE ip = ? AND created_at > ?").bind(ip, now() - 3600e3).first();
	const day = await env.DB.prepare("SELECT COUNT(*) AS n FROM support WHERE email = ? AND created_at > ?").bind(email, now() - 86400e3).first();
	if ((hour && hour.n >= 5) || (day && day.n >= 6)) throw fail(429, "We've got your messages. We'll answer those first: no need to send more.");
	const t = await openTicket(env, { user, email, category, message, details, ip });
	return json({ ok: true, id: t.id, mailed: t.mailed });
}
async function supportList(env, user) {
	const rows = await env.DB.prepare("SELECT id, category, subject, status, created_at FROM support WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").bind(user.id).all();
	return json({ requests: rows.results || [] });
}
async function supportSolved(env, user, tid) {
	const r = await env.DB.prepare("UPDATE support SET status = 'solved' WHERE id = ? AND user_id = ?").bind(tid, user.id).run();
	if (!(r.meta && r.meta.changes)) throw fail(404, "That request isn't yours, or isn't there.");
	return json({ ok: true });
}
// A refund the customer asks for themselves: a payment of theirs (QRIS or card), within the policy's days, with less than
// its share used since (a plan: what's been charged since it started, against its month of credits; a pack: what's left of
// its credits). What it bought ends at once; the owner gets a request with exactly what to send back and to whom.
async function refundAsk(req, env, user) {
	const c = await config(env), b = await body(req);
	const pay = await env.DB.prepare("SELECT * FROM payments WHERE id = ? AND user_id = ?").bind(String(b.payment || ""), user.id).first();
	if (!pay) throw fail(404, "That payment isn't on your account.");
	if (pay.status !== "approved" || !["qris", "card"].includes(pay.method)) throw fail(400, pay.status === "refund_requested" ? "That refund is already on its way." : "That payment can't be refunded here: write to us and we'll sort it out.");
	const since = Number(pay.decided_at || pay.created_at) || 0, days = Number(c.refund.days) || 7, share = Number(c.refund.usedShare) || 0.2;
	if (now() - since > days * 86400e3) throw fail(400, "Refunds are for the first " + days + " days after paying. Write to us if something went wrong, and we'll see what we can do.");
	const plan = /^plan:/.test(pay.pack || "") ? c.plans.find((x) => "plan:" + x.id === pay.pack) : null;
	const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
	let undo;
	if (plan) {
		const used = await env.DB.prepare("SELECT COALESCE(SUM(charged_mc), 0) AS mc FROM usage WHERE user_id = ? AND created_at >= ?").bind(user.id, since).first();
		if ((Number(used && used.mc) || 0) > share * plan.month * 1000) throw fail(400, "More than " + Math.round(share * 100) + "% of that month's credits are used, so it can't be refunded. Write to us if something went wrong.");
		// that month comes off the end (a plan since swapped for another: what it became there, the same share of its price);
		// cutting into the month running cuts its credits to the days left; with nothing left, the plan ends now
		const cur = (u.plan && c.plans.find((x) => x.id === u.plan)) || plan, price = (p) => Number(p.prices && p.prices.IDR) || 0;
		const off = plan.days * 86400e3 * (cur.id === plan.id || !price(cur) ? 1 : price(plan) / price(cur));
		const until = Math.max(now(), Number(u.plan_until || 0) - off), per = Number(u.period_at) || 0;
		const keep = until <= now() ? 0 : per > until || !per ? Math.round(cur.month * 1000 * (until - now()) / (cur.days * 86400e3)) : -1;
		undo = env.DB.prepare("UPDATE users SET plan_until = ?1, period_at = CASE WHEN ?2 = 0 THEN 0 WHEN period_at > ?1 THEN ?1 ELSE period_at END, plan_mc = CASE WHEN ?2 >= 0 THEN MIN(plan_mc, ?2) ELSE plan_mc END WHERE id = ?3").bind(until, keep, user.id);
	} else {
		if ((Number(u.balance_mc) || 0) < (1 - share) * pay.credits_mc) throw fail(400, "More than " + Math.round(share * 100) + "% of those credits are used, so they can't be refunded. Write to us if something went wrong.");
		undo = env.DB.prepare("UPDATE users SET balance_mc = MAX(0, balance_mc - ?) WHERE id = ?").bind(pay.credits_mc, user.id);
	}
	const ok = await env.DB.prepare("UPDATE payments SET status = 'refund_requested' WHERE id = ? AND status = 'approved'").bind(pay.id).run();
	if (!(ok.meta && ok.meta.changes)) throw fail(409, "That refund is already on its way.");
	await undo.run();
	const what = plan ? plan.name + " (a month)" : (c.packs.find((x) => x.id === pay.pack) || {}).name + " pack";
	const money = (pay.currency === "IDR" ? "Rp" + Number(pay.amount).toLocaleString("id-ID") : pay.amount + " " + pay.currency);
	const how = pay.method === "card" ? "Refund it in Lemon Squeezy (Orders, find this order, Refund)." : "Send " + money + " back to the account it was paid from (it was paid as: " + (pay.note || "no name given") + "), then reply to the customer that it's on its way.";
	const t = await openTicket(env, { user, email: user.email, category: "Payments and refunds", message: "Refund request: " + what + ", " + money + " (" + pay.method.toUpperCase() + ").\n\nTO DO: " + how, details: "Payment " + pay.id + ", paid " + new Date(since).toISOString().slice(0, 16).replace("T", " ") + " UTC. What it bought has been taken off the account already.", ip: null });
	return json({ ok: true, ticket: t.id, me: await meOf(env, user) });
}

// ------------------------------------------------------------------ pictures shared with a connected app
// An app the user connected (Higgsfield, say) can't see what's attached in the chat: it fetches a picture from a link. So
// a picture going to one is kept here for a day at a link nobody can guess (96 random hex characters), then deleted.

const UPLOAD_LIFE = 86400e3, UPLOAD_MAX = 1900000, UPLOAD_DAY = 60;
const UPLOAD_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
async function uploadPut(req, env, user, url) {
	const b = await body(req);
	const m = String(b.data || "").match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
	if (!m) throw fail(400, "Only a picture (PNG, JPEG, WebP or GIF) can be shared with an app.");
	const bytes = unb64(m[2]);
	if (bytes.length > UPLOAD_MAX) throw fail(413, "That picture is too big to share with an app.");
	const day = await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE user_id = ? AND created_at > ?").bind(user.id, now() - UPLOAD_LIFE).first();
	if (day && day.n >= UPLOAD_DAY) throw fail(429, "That's a lot of pictures shared with apps today. Try again tomorrow.");
	const key = id() + id() + id() + id();
	await env.DB.prepare("INSERT INTO uploads (id, user_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)").bind(key, user.id, m[1], bytes, now()).run();
	return json({ url: url.origin + "/api/uploads/" + key + "." + UPLOAD_EXT[m[1]], expires: now() + UPLOAD_LIFE });
}
async function uploadGet(env, key) {
	const row = await env.DB.prepare("SELECT type, data, created_at FROM uploads WHERE id = ?").bind(key).first();
	if (!row || row.created_at < now() - UPLOAD_LIFE) throw fail(404, "That link has expired.");
	return new Response(new Uint8Array(row.data), { headers: { "Content-Type": row.type, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" } });
}
