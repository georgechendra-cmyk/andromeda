// The owner's desk, for what used to be the admin page: run on the owner's computer (signed in to Cloudflare with
// `npx wrangler login`), it reads and changes Celestin's database directly. Nothing here is online.
//
//   node owner.mjs pending                     payments waiting to be confirmed (check your e-wallet first)
//   node owner.mjs approve <payment id>        a confirmed payment: its plan starts, or its credits are added
//   node owner.mjs reject <payment id>
//   node owner.mjs plan <email> <plan> [days]  give a plan (nova, pulsar, quasar) from today, or added to the one running
//   node owner.mjs credits <email> <n>         add (or, negative, take) pack credits
//   node owner.mjs stats                       what's been sold, what AI has cost, and free use by day
//
// Prices, plans and the shop's settings are in worker.js (DEFAULT_CONFIG); this reads the plans from there.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = new URL(".", import.meta.url), DIR = fileURLToPath(HERE);
// npx run by node itself, so the SQL reaches wrangler exactly as written (a Windows shell would mangle quotes and spaces)
const NPX = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
const src = readFileSync(new URL("worker.js", HERE), "utf8");
const at = src.indexOf("const DEFAULT_CONFIG = {");
let depth = 0, end = at + "const DEFAULT_CONFIG = ".length;
for (let i = end; i < src.length; i++) {
	if (src[i] === "{") depth++;
	else if (src[i] === "}" && --depth === 0) { end = i + 1; break; }
}
const CONFIG = Function("return (" + src.slice(at + "const DEFAULT_CONFIG = ".length, end) + ")")();

const q = (v) => (v == null ? "NULL" : typeof v === "number" ? String(Math.round(v)) : "'" + String(v).replace(/'/g, "''") + "'");
function sql(command) {
	const args = ["--yes", "wrangler@4", "d1", "execute", "andromeda", "--remote", "--json", "--command", command];
	const out = existsSync(NPX) ? execFileSync(process.execPath, [NPX, ...args], { cwd: DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
		: execFileSync("npx", args, { cwd: DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const j = JSON.parse(out.slice(out.indexOf("[")));
	return (j[0] && j[0].results) || [];
}
const userOf = (email) => {
	const u = sql("SELECT id, email, plan, plan_until FROM users WHERE email = " + q(String(email || "").trim().toLowerCase()))[0];
	if (!u) throw new Error("No account with that email.");
	return u;
};
// a month (or days) of a plan, from today or from the end of the one running; a plan that wasn't running starts with a
// full window (the same as startPlan in worker.js)
function startPlan(u, plan, days) {
	const t = Date.now(), running = u.plan && Number(u.plan_until) > t;
	const until = (running ? Number(u.plan_until) : t) + (Number(days) || plan.days || 30) * 86400e3;
	// (each payment adds one month of credits: to what's left of the same plan, or to what's left of the plan it replaces)
	const add = Math.round((plan.month || 0) * 1000 * ((Number(days) || plan.days || 30) / (plan.days || 30)));
	if (running && u.plan === plan.id) sql("UPDATE users SET plan_until = " + q(until) + ", plan_mc = plan_mc + " + q(add) + " WHERE id = " + q(u.id));
	else sql("UPDATE users SET plan = " + q(plan.id) + ", plan_until = " + q(until) + ", plan_mc = " + (running ? "MAX(0, plan_mc) + " : "") + q(add) + ", free_mc = " + q(plan.credits * 1000) + ", free_reset_at = 0, week_mc = 0, week_at = 0 WHERE id = " + q(u.id));
	return new Date(until).toISOString().slice(0, 10);
}

const [cmd, ...args] = process.argv.slice(2);
const money = (p) => (p.currency === "IDR" ? "Rp" + Number(p.amount).toLocaleString("id-ID") : p.amount + " " + p.currency);
if (cmd === "pending") {
	const rows = sql("SELECT p.id, p.pack, p.amount, p.currency, p.credits_mc, p.note, p.created_at, u.email FROM payments p JOIN users u ON u.id = p.user_id WHERE p.status = 'pending' ORDER BY p.created_at");
	if (!rows.length) console.log("Nothing waiting.");
	for (const p of rows) console.log(p.id + "  " + new Date(p.created_at).toLocaleString() + "  " + p.email + "  " + money(p) + "  paid as: " + (p.note || "?") + "  for: " + (/^plan:/.test(p.pack || "") ? p.pack.slice(5) + " (a month)" : p.credits_mc / 1000 + " credits"));
} else if (cmd === "approve" || cmd === "reject") {
	const p = sql("SELECT * FROM payments WHERE id = " + q(args[0]) + " AND status = 'pending'")[0];
	if (!p) throw new Error("No payment waiting with that id.");
	sql("UPDATE payments SET status = " + q(cmd === "approve" ? "approved" : "rejected") + ", decided_at = " + q(Date.now()) + " WHERE id = " + q(p.id) + " AND status = 'pending'");
	if (cmd === "approve") {
		const plan = /^plan:/.test(p.pack || "") && CONFIG.plans.find((x) => "plan:" + x.id === p.pack);
		const u = sql("SELECT id, plan, plan_until FROM users WHERE id = " + q(p.user_id))[0];
		if (plan) console.log("Approved: " + plan.name + " until " + startPlan(u, plan) + ".");
		else { sql("UPDATE users SET balance_mc = balance_mc + " + q(p.credits_mc) + " WHERE id = " + q(p.user_id)); console.log("Approved: " + p.credits_mc / 1000 + " credits added."); }
	} else console.log("Rejected.");
} else if (cmd === "plan") {
	const plan = CONFIG.plans.find((x) => x.id === String(args[1] || "").toLowerCase());
	if (!plan) throw new Error("Which plan? " + CONFIG.plans.map((x) => x.id).join(", "));
	console.log(plan.name + " until " + startPlan(userOf(args[0]), plan, args[2]) + ".");
} else if (cmd === "credits") {
	const u = userOf(args[0]), n = Number(args[1]);
	if (!Number.isFinite(n) || !n) throw new Error("How many credits?");
	sql("INSERT INTO payments (id, user_id, method, amount, currency, credits_mc, status, note, created_at, decided_at) VALUES (" + [randomBytes(12).toString("hex"), u.id, "manual", 0, "USD", n * 1000, "approved", "by hand", Date.now(), Date.now()].map(q).join(", ") + ")");
	sql("UPDATE users SET balance_mc = MAX(0, balance_mc + " + q(n * 1000) + ") WHERE id = " + q(u.id));
	console.log((n > 0 ? "Added " : "Took ") + Math.abs(n) + " credits.");
} else if (cmd === "stats") {
	for (const t of sql("SELECT currency, SUM(amount) AS amount, COUNT(*) AS n FROM payments WHERE status = 'approved' AND method != 'manual' GROUP BY currency")) console.log("Sold: " + money(t) + " (" + t.n + ")");
	const s = sql("SELECT SUM(cost_usd) AS cost, SUM(charged_mc) AS charged, COUNT(*) AS n FROM usage")[0] || {};
	console.log("AI cost so far: $" + (Number(s.cost) || 0).toFixed(2) + " for " + Math.round((s.charged || 0) / 1000) + " credits used (" + (s.n || 0) + " calls)");
	const rate = CONFIG.free.usdIdr || 18000;
	for (const d of sql("SELECT substr(day, 7) AS day, mc / 1e6 AS usd FROM free_days WHERE day LIKE 'spent:%' ORDER BY day DESC LIMIT 7")) console.log("Free use " + d.day + ": Rp" + Math.round(d.usd * rate).toLocaleString("id-ID"));
	const u = sql("SELECT COUNT(*) AS n, SUM(CASE WHEN plan IS NOT NULL AND plan_until > " + q(Date.now()) + " THEN 1 ELSE 0 END) AS paid FROM users")[0] || {};
	console.log("Accounts: " + (u.n || 0) + ", on a paid plan: " + (u.paid || 0));
} else {
	console.log(readFileSync(new URL("owner.mjs", HERE), "utf8").split("\n").slice(3, 11).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
