// Celestin Connector: the apps on this computer, for Celestin in your browser.
//
// Any MCP server (the same ones Claude Desktop uses: Blender, Figma, Unity, your files, GitHub, a database...) runs here,
// and Celestin talks to it over http://127.0.0.1:8765. Servers come from connections.json beside this file and, if you
// use Claude Desktop, from its own config, so whatever you've set up for Claude works in Celestin too.
//
//   node tools/connector.mjs            (or double-click "CONNECT APPS.bat")
//
// connections.json looks like Claude Desktop's:
//   { "mcpServers": { "blender": { "command": "uvx", "args": ["blender-mcp"] },
//                     "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/me/Documents"] },
//                     "some-online-one": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } } } }
//
// Only Celestin can use it: it listens on this computer alone, answers only Celestin's own pages, and wants the
// pairing code it prints (paste it into Celestin once, under Connect apps).
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANDROMEDA_CONNECTOR_PORT || 8765);
const ORIGINS = [/^https:\/\/([a-z0-9-]+\.)?celestin\.pages\.dev$/, /^https:\/\/georgechendra-cmyk\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, /^null$/, ...(process.env.ANDROMEDA_ORIGINS || "").split(",").filter(Boolean).map((o) => new RegExp("^" + o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"))];

// the pairing code: made once, kept beside this file
const codeFile = join(here, ".connector-code");
const CODE = existsSync(codeFile) ? readFileSync(codeFile, "utf8").trim() : randomBytes(9).toString("base64url");
if (!existsSync(codeFile)) writeFileSync(codeFile, CODE);

function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
function servers() {
	const claude = process.platform === "win32" ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
		: process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json") : join(homedir(), ".config", "Claude", "claude_desktop_config.json");
	// this computer itself, built in (connections.json can say "computer": false to leave it out)
	const own = readJson(join(here, "connections.json"));
	const out = own && own.computer === false ? {} : { computer: { builtin: true } };
	for (const f of [claude, join(here, "connections.json")]) {
		const j = readJson(f);
		for (const [name, s] of Object.entries((j && j.mcpServers) || {})) if (s && (s.command || s.url)) out[name.replace(/[^\w-]/g, "-")] = s;
	}
	return out;
}

// ---- a server on this computer: a program that speaks MCP over its stdin and stdout, one JSON message a line
const RUNNING = new Map();
function start(name, s) {
	const child = spawn(s.command, s.args || [], { env: { ...process.env, ...(s.env || {}) }, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
	const p = { child, waiting: new Map(), buf: "" };
	child.stdout.on("data", (d) => {
		p.buf += d;
		let i;
		while ((i = p.buf.indexOf("\n")) >= 0) {
			const line = p.buf.slice(0, i).trim();
			p.buf = p.buf.slice(i + 1);
			if (!line) continue;
			let m;
			try { m = JSON.parse(line); } catch { continue; }
			if (m.id != null && !m.method && p.waiting.has(m.id)) { p.waiting.get(m.id)(m); p.waiting.delete(m.id); }
			// the server asking Celestin something (roots, sampling): not offered, said so, so it never waits forever
			else if (m.id != null && m.method) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Not supported by Celestin" } }) + "\n");
		}
	});
	child.stderr.on("data", (d) => process.stderr.write("[" + name + "] " + d));
	child.on("exit", (code) => {
		console.log("[" + name + "] stopped (" + code + ")");
		for (const done of p.waiting.values()) done({ jsonrpc: "2.0", error: { code: -32000, message: name + " stopped" } });
		RUNNING.delete(name);
	});
	child.on("error", (e) => console.log("[" + name + "] couldn't start: " + e.message));
	RUNNING.set(name, p);
	return p;
}
function ask(name, s, msg) {
	const p = RUNNING.get(name) || start(name, s);
	if (msg.id == null) { p.child.stdin.write(JSON.stringify(msg) + "\n"); return Promise.resolve(null); }
	return new Promise((resolve) => {
		const t = setTimeout(() => { p.waiting.delete(msg.id); resolve({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: name + " took too long to answer" } }); }, 300000);
		p.waiting.set(msg.id, (m) => { clearTimeout(t); resolve(m); });
		p.child.stdin.write(JSON.stringify(msg) + "\n");
	});
}
// ---- an online server: passed straight through (from here there's no browser in the way)
async function relay(s, req, body) {
	const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(s.headers || {}) };
	for (const h of ["mcp-session-id", "mcp-protocol-version"]) if (req.headers[h]) headers[h] = req.headers[h];
	const r = await fetch(s.url, { method: "POST", headers, body });
	return { status: r.status, type: r.headers.get("content-type") || "application/json", session: r.headers.get("mcp-session-id"), text: await r.text() };
}

http.createServer(async (req, res) => {
	const origin = req.headers.origin || "";
	const allowed = !origin || ORIGINS.some((re) => re.test(origin));
	const cors = allowed && origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, content-type, accept, mcp-session-id, mcp-protocol-version", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Expose-Headers": "mcp-session-id", "Access-Control-Allow-Private-Network": "true" } : {};
	const send = (status, obj, extra = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...cors, ...extra }); res.end(obj == null ? "" : JSON.stringify(obj)); };
	if (req.method === "OPTIONS") { res.writeHead(allowed ? 204 : 403, cors); return res.end(); }
	if (!allowed) return send(403, { error: "Only Celestin can use this connector." });
	const u0 = new URL(req.url, "http://x");
	if (u0.pathname === "/vault" || u0.pathname.startsWith("/vault/")) return vaultRoute(req, res, u0);
	if ((req.headers.authorization || "") !== "Bearer " + CODE) return send(401, { error: "Wrong pairing code. Copy it from the connector's window." });
	const url = new URL(req.url, "http://x");
	const all = servers();
	if (req.method === "GET" && url.pathname === "/servers") return send(200, { servers: Object.entries(all).map(([name, s]) => ({ name, url: "http://127.0.0.1:" + PORT + "/" + name + "/mcp", kind: s.url ? "online" : "local" })) });
	const m = url.pathname.match(/^\/([\w-]+)\/mcp$/);
	const s = m && all[m[1]];
	if (!s) return send(404, { error: "No server by that name. Add it to connections.json." });
	if (req.method === "DELETE") return send(204, null);
	if (req.method !== "POST") return send(405, { error: "POST MCP messages here." });
	let body = "";
	for await (const chunk of req) body += chunk;
	try {
		if (s.builtin) {
			const msgs = JSON.parse(body), list = Array.isArray(msgs) ? msgs : [msgs];
			const answers = (await Promise.all(list.map(computer))).filter(Boolean);
			if (!answers.length) return send(202, null);
			return send(200, Array.isArray(msgs) ? answers : answers[0], { "mcp-session-id": "local-computer" });
		}
		if (s.url) {
			const r = await relay(s, req, body);
			res.writeHead(r.status, { "Content-Type": r.type, ...cors, ...(r.session ? { "mcp-session-id": r.session } : {}) });
			return res.end(r.text);
		}
		const msgs = JSON.parse(body);
		const list = Array.isArray(msgs) ? msgs : [msgs];
		const answers = (await Promise.all(list.map((x) => ask(m[1], s, x)))).filter(Boolean);
		if (!answers.length) return send(202, null);
		return send(200, Array.isArray(msgs) ? answers : answers[0], { "mcp-session-id": "local-" + m[1] });
	} catch (e) {
		return send(500, { jsonrpc: "2.0", error: { code: -32603, message: String(e.message || e) } });
	}
}).listen(PORT, "127.0.0.1", () => {
	const names = Object.keys(servers());
	console.log("\n  Celestin Connector is on. Leave this window open while you use Celestin.\n");
	console.log("  Pairing code (paste it into Celestin, under Connect apps):  " + CODE + "\n");
	console.log("  Apps: " + (names.length ? names.join(", ") : "none yet. Add them to tools/connections.json (see connections.example.json)") + "\n");
});

// ------------------------------------------------------------------ this computer itself
// What an engineer at this computer does: run commands and programs (and keep long ones going in the background), read,
// write and edit files, find and search them, open things, and look at the screen. Celestin asks the user before
// anything that changes something, showing exactly what (the command, the file and the change).
const HOME = homedir(), WIN = process.platform === "win32";
const SKIP = /^(node_modules|\.git|\.gradle|build|dist|target|__pycache__|\.venv|venv|\.next|\.cache|AppData)$/;
const IMAGE = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
const at = (p, cwd) => resolve(cwd ? resolve(HOME, cwd) : HOME, String(p || "."));
const S = (description) => ({ type: "string", description }), N = (description) => ({ type: "number", description });
const COMPUTER = [
	["run_command", "Run a command on the user's computer and wait for it to finish (" + (WIN ? "PowerShell" : "bash") + "). Returns everything it printed and its exit code. Anything that keeps running (a server, a watcher, a game) goes in start_command instead.", { command: S("the command"), cwd: S("the folder to run it in (default: the user's home folder)"), timeout_seconds: N("how long to wait, default 300, at most 3600") }, ["command"]],
	["start_command", "Start a long-running command in the background (a dev server, a long build, a game server). Returns a job id; read_job shows its output.", { command: S("the command"), cwd: S("the folder to run it in") }, ["command"]],
	["read_job", "What a background job has printed since you last looked, and whether it's still running.", { id: S("the job id") }, ["id"]],
	["stop_job", "Stop a background job (and everything it started).", { id: S("the job id") }, ["id"]],
	["read_file", "Read a text file, with line numbers (or look at an image file).", { path: S("the file (absolute, or from the user's home folder)"), offset: N("the first line, from 1"), limit: N("how many lines, default 2000") }, ["path"]],
	["write_file", "Create a file or replace all of it (the folders are made as needed).", { path: S("the file"), content: S("everything that goes in it") }, ["path", "content"]],
	["edit_file", "Change part of a file: old_text (exactly as it is in the file, appearing once unless replace_all) becomes new_text.", { path: S("the file"), old_text: S("the exact text to replace"), new_text: S("what it becomes"), replace_all: { type: "boolean", description: "replace every copy" } }, ["path", "old_text", "new_text"]],
	["list_files", "List the files under a folder, optionally only those matching a pattern like **/*.java.", { path: S("the folder"), pattern: S("a glob pattern") }, ["path"]],
	["search_files", "Search the files under a folder for a regular expression (like grep). Returns the matching lines with where they are.", { path: S("the folder (or one file)"), regex: S("the regular expression"), pattern: S("only files matching this glob, like *.ts") }, ["path", "regex"]],
	["open", "Open a file, folder or web link in its usual app on the user's computer.", { target: S("the path or link") }, ["target"]],
	["screenshot", "See the user's whole screen right now.", {}, []],
	["browse_open", "Open a website in Celestin's own browser window on the user's computer (they can see it; sites they've signed in to there stay signed in). Returns the page's words and its links, buttons and fields, numbered.", { url: S("the address") }, ["url"]],
	["browse_read", "Read the open page again (after it changed), with its controls numbered.", {}, []],
	["browse_click", "Click a link or button on the open page by its number (from browse_open or browse_read). Returns the page after.", { n: N("its number"), what: S("what it is, in a few words, as the user will see it when asked (like: the Post button)") }, ["n", "what"]],
	["browse_type", "Type into a field on the open page by its number, replacing what's in it (enter: true presses Enter after). Never a password: use browse_login.", { n: N("the field's number"), text: S("what to type"), what: S("what the field is, in a few words (like: the search box)"), enter: { type: "boolean", description: "press Enter after" } }, ["n", "text", "what"]],
	["browse_login", "Sign in on the open page with the login the user saved for this site in their password vault on their computer: the computer types it in itself, so you never see it, and only on the exact site it was saved for. If none is saved, ask them to add it under Plugins, then Passwords. Never ask the user for a password.", { site: S("the site, as the user will see it when asked (like: instagram.com)") }, ["site"]],
	["browse_look", "See the open page as a picture.", {}, []],
];
const JOBS = new Map();
let jobN = 0;
const cap = (s, n = 60000) => (s.length > n ? s.slice(0, n / 2) + "\n… (" + (s.length - n) + " characters cut) …\n" + s.slice(-n / 2) : s);
function shell(command, cwd) {
	return spawn(WIN ? "powershell.exe" : "bash", WIN ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command], { cwd: cwd ? at(cwd) : HOME, env: process.env, windowsHide: true });
}
const kill = (child) => { try { if (WIN) spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)]); else child.kill("SIGTERM"); } catch {} };
const globRe = (g) => new RegExp("^" + String(g).replace(/\\/g, "/").replace(/[.+^${}()|[\]]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$", "i");
function walk(root, fn, limit = 20000) {
	let n = 0;
	const go = (dir) => {
		let items;
		try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const d of items) {
			if (n >= limit) return;
			const p = join(dir, d.name);
			if (d.isDirectory()) { if (!SKIP.test(d.name)) go(p); }
			else { n++; if (fn(p) === false) { n = limit; return; } }
		}
	};
	go(root);
}
const text = (t) => [{ type: "text", text: t }];

// ------------------------------------------------------------------ the password vault: on this computer only
// Logins are kept here encrypted (AES-256-GCM; its key in a file only this computer's user reads) and never leave this
// computer: Celestin's server, its web page and every AI model never see one. browse_login types a login into Celestin's
// browser window itself, only on the site it was saved for (a look-alike site gets nothing), and Celestin asks first.
const VDIR = join(HOME, ".celestin"), VKEY = join(VDIR, "vault.key"), VFILE = join(VDIR, "vault.json");
function vaultKey() { mkdirSync(VDIR, { recursive: true }); if (!existsSync(VKEY)) writeFileSync(VKEY, randomBytes(32).toString("base64"), { mode: 0o600 }); return Buffer.from(readFileSync(VKEY, "utf8").trim(), "base64"); }
const vaultAll = () => ((readJson(VFILE) || {}).logins || []);
function vaultSave(list) { mkdirSync(VDIR, { recursive: true }); writeFileSync(VFILE, JSON.stringify({ logins: list }, null, 1), { mode: 0o600 }); }
function seal(t) { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", vaultKey(), iv), d = Buffer.concat([c.update(String(t), "utf8"), c.final()]); return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), d: d.toString("base64") }; }
function unseal(x) { const c = createDecipheriv("aes-256-gcm", vaultKey(), Buffer.from(x.iv, "base64")); c.setAuthTag(Buffer.from(x.tag, "base64")); return Buffer.concat([c.update(Buffer.from(x.d, "base64")), c.final()]).toString("utf8"); }
const hostOf = (u) => { try { return new URL(/^https?:\/\//i.test(u) ? u : "https://" + String(u).trim()).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
// a saved login fits a page only on its own site or that site's own subdomains (accounts.example.com for example.com)
const fits = (saved, host) => { const h = String(host || "").toLowerCase().replace(/^www\./, ""); return !!saved && (h === saved || h.endsWith("." + saved)); };
const escH = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function vaultPage(note) {
	const rows = vaultAll().map((x, i) => '<tr><td><b>' + escH(x.site) + '</b></td><td>' + escH(x.user) + '</td><td style="text-align:right"><form method="post" action="/vault/remove"><input type="hidden" name="code" value="' + CODE + '"><input type="hidden" name="i" value="' + i + '"><button class="q">Remove</button></form></td></tr>').join("");
	return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Passwords · Celestin</title><style>body{font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;max-width:620px;margin:48px auto;padding:0 16px;color:#0d0d0e;background:#f7f7f9}h1{font-size:24px;margin:0 0 6px}p.n{color:#5f6063;margin:0 0 18px}table{width:100%;border-collapse:collapse;margin:8px 0 26px;background:#fff;border-radius:12px}td{padding:10px 12px;border-bottom:1px solid #ececf0}label{display:block;font-weight:600;font-size:14px}input{font:inherit;padding:10px 12px;border:1px solid #d6d6dc;border-radius:10px;width:100%;box-sizing:border-box;margin:5px 0 14px;background:#fff}button{font:inherit;font-weight:600;padding:10px 18px;border:0;border-radius:999px;background:#0d0d0e;color:#fff;cursor:pointer}button.q{background:#ececf0;color:#0d0d0e;padding:6px 12px;font-weight:500}.ok{background:#fff;border-radius:10px;padding:10px 12px;margin:0 0 14px}</style></head><body>' +
		'<h1>Passwords</h1><p class="n">Kept encrypted on this computer, and only here. Celestin\'s server, its web page and every AI never see them. When your team needs to sign in, this computer types the login into Celestin\'s browser window itself, only on the site it was saved for, and Celestin asks you each time first.</p>' +
		(note ? '<div class="ok">' + escH(note) + '</div>' : '') + '<table>' + (rows || '<tr><td class="n" style="color:#5f6063">No logins saved yet.</td></tr>') + '</table>' +
		'<h2 style="font-size:17px">Add a login</h2><form method="post" action="/vault/add" autocomplete="off"><input type="hidden" name="code" value="' + CODE + '"><label>Website<input name="site" placeholder="instagram.com" required></label><label>Username or email<input name="user" required></label><label>Password<input name="pass" type="password" autocomplete="new-password" required></label><button>Save on this computer</button></form></body></html>';
}
async function vaultRoute(req, res, u) {
	const html = (status, body) => { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" }); res.end(body); };
	let form = {};
	if (req.method === "POST") { let b = ""; for await (const c of req) { b += c; if (b.length > 1e5) break; } form = Object.fromEntries(new URLSearchParams(b)); }
	const code = req.method === "POST" ? form.code : u.searchParams.get("code");
	if (code !== CODE) return html(401, "<p style='font:15px system-ui;margin:40px'>Open Passwords from Celestin (Plugins, then Passwords), with this computer's connector running.</p>");
	if (u.pathname === "/vault/add" && req.method === "POST") {
		const site = hostOf(form.site || "");
		if (!site || !form.user || !form.pass) return html(400, vaultPage("Fill in the website, the username and the password."));
		const list = vaultAll().filter((x) => !(x.site === site && x.user === form.user));
		list.push({ site, user: String(form.user).slice(0, 200), secret: seal(String(form.pass)), at: Date.now() });
		vaultSave(list);
		return html(200, vaultPage("Saved for " + site + ", on this computer only."));
	}
	if (u.pathname === "/vault/remove" && req.method === "POST") { const list = vaultAll(), x = list[Number(form.i)]; if (x) { list.splice(Number(form.i), 1); vaultSave(list); } return html(200, vaultPage(x ? "Removed " + x.site + "." : "")); }
	return html(200, vaultPage(""));
}

// ------------------------------------------------------------------ websites, in a browser window on this computer
// Celestin's own browser window (Edge or Chrome, with its own profile in ~/.celestin/browser, so a site signed in to stays
// signed in): open a page, read it with its controls numbered, click, type, sign in from the vault, look at it. It's
// visible on the screen, so the user sees what their team does and types any code a site sends them themselves.
const BROWSERS = WIN ? [join(process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"), join(process.env.ProgramFiles || "C:/Program Files", "Microsoft/Edge/Application/msedge.exe"), join(process.env.ProgramFiles || "C:/Program Files", "Google/Chrome/Application/chrome.exe"), join(process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)", "Google/Chrome/Application/chrome.exe"), join(process.env.LOCALAPPDATA || HOME, "Google/Chrome/Application/chrome.exe")]
	: process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
let BR = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function br() {
	if (BR && BR.ws.readyState === 1) return BR;
	if (typeof WebSocket === "undefined") throw new Error("Using websites needs Node 22 or newer on this computer: update it from nodejs.org, then start the connector again.");
	const exe = BROWSERS.find((p) => p && existsSync(p));
	if (!exe) throw new Error("No Edge or Chrome was found on this computer.");
	const port = 9500 + Math.floor(Math.random() * 400), prof = join(HOME, ".celestin", "browser");
	mkdirSync(prof, { recursive: true });
	const proc = spawn(exe, ["--remote-debugging-port=" + port, "--remote-allow-origins=http://127.0.0.1:" + port, "--user-data-dir=" + prof, "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", ...(process.env.CELESTIN_HEADLESS ? ["--headless=new"] : []), "about:blank"], { stdio: "ignore" });
	let pages = [];
	for (let i = 0; i < 80; i++) { try { pages = await (await fetch("http://127.0.0.1:" + port + "/json")).json(); if (pages.some((p) => p.type === "page")) break; } catch {} await sleep(250); }
	const page = pages.find((p) => p.type === "page");
	if (!page) throw new Error("The browser didn't start.");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("Couldn't reach the browser window.")); });
	const wait = new Map();
	let n = 0;
	ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
	const send = (method, params = {}) => new Promise((ok) => { const i = ++n; wait.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (wait.delete(i)) ok({ error: { message: method + " took too long" } }); }, 30000); });
	await send("Page.enable");
	await send("Runtime.enable");
	BR = { proc, ws, send };
	proc.on("exit", () => { BR = null; });
	ws.onclose = () => { BR = null; };
	return BR;
}
async function inPage(expr) {
	const b = await br(), r = await b.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
	if (r.error) throw new Error(r.error.message);
	const x = r.result || {};
	if (x.exceptionDetails) throw new Error("The page said: " + String((x.exceptionDetails.exception && x.exceptionDetails.exception.description) || x.exceptionDetails.text || "error").slice(0, 200));
	return x.result && x.result.value;
}
// the page in words, and every control on it numbered (never a password field's contents)
const SNAP = "(() => { const out = []; let n = 0; const vis = (e) => { const b = e.getBoundingClientRect(), s = getComputedStyle(e); return b.width > 2 && b.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };" +
	" for (const e of document.querySelectorAll('[data-celestin-n]')) e.removeAttribute('data-celestin-n');" +
	" for (const e of document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [contenteditable=true]')) { if (e.type === 'hidden' || !vis(e)) continue; n++; e.setAttribute('data-celestin-n', n);" +
	" const pw = e.type === 'password', label = String(e.getAttribute('aria-label') || e.placeholder || (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' ? '' : e.innerText) || e.name || e.title || '').trim().replace(/\\s+/g, ' ').slice(0, 80), val = !pw && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') && e.value ? ' = \"' + String(e.value).slice(0, 60) + '\"' : '';" +
	" out.push(n + '. ' + (e.tagName === 'A' ? 'link' : e.tagName === 'INPUT' ? (pw ? 'password field (use browse_login)' : (e.type || 'text') + ' field') : e.tagName === 'TEXTAREA' ? 'text box' : e.tagName === 'SELECT' ? 'choice' : 'button') + (label ? ': ' + label : '') + val); if (n >= 160) break; }" +
	" return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 9000), items: out }; })()";
async function settle() { for (let i = 0; i < 40; i++) { const st = await inPage("document.readyState").catch(() => ""); if (st === "complete") break; await sleep(250); } await sleep(600); }
async function snapshot(lead) { await settle(); const p = await inPage(SNAP); return text((lead ? lead + "\n\n" : "") + "Page: " + p.title + " (" + p.url + ")\n\n" + p.text + "\n\nWhat's on it to use (by number):\n" + (p.items.join("\n") || "(nothing)")); }
async function clickAt(x, y) { const b = await br(); for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await b.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); }
async function pressEnter() { const b = await br(); await b.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); await b.send("Input.dispatchKeyEvent", { type: "char", text: "\r", key: "Enter" }); await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); }
// a control by its number: scrolled into view, its middle (and whether it's a password field)
async function controlAt(n) {
	const r = await inPage("(() => { const e = document.querySelector('[data-celestin-n=\"" + Number(n) + "\"]'); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, pw: e.type === 'password' }; })()");
	if (!r) throw new Error("There's no number " + n + " on the page now: read it again with browse_read.");
	return r;
}
// focus a field (found by an expression) by clicking it, its contents selected so typing replaces them
async function focusField(expr) {
	const r = await inPage("(() => { const e = " + expr + "; if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()");
	if (!r) return false;
	await clickAt(r.x, r.y);
	await inPage("(() => { const a = document.activeElement; if (a && a.select) a.select(); return 1; })()");
	return true;
}
const VIS = "((e) => { const b = e.getBoundingClientRect(); return b.width > 2 && b.height > 2 && !e.disabled; })";
const USER_SEL = "input[type=email], input[autocomplete=username], input[name*=user i], input[name*=email i], input[name*=login i], input[id*=user i], input[id*=email i], input[type=text], input:not([type])";
async function browse(name, a) {
	if (name === "browse_open") {
		let url = String(a.url || "").trim();
		if (!/^https?:\/\//i.test(url)) url = "https://" + url;
		const b = await br();
		await b.send("Page.navigate", { url });
		return snapshot("");
	}
	if (name === "browse_read") return snapshot("");
	if (name === "browse_click") { const c = await controlAt(a.n); await clickAt(c.x, c.y); await sleep(1200); return snapshot("Clicked " + a.n + "."); }
	if (name === "browse_type") {
		const c = await controlAt(a.n);
		if (c.pw) throw new Error("That's a password field: use browse_login, so the password is typed by this computer and never passes through you.");
		await clickAt(c.x, c.y);
		await inPage("(() => { const a = document.activeElement; if (a && a.select) a.select(); return 1; })()");
		const b = await br();
		await b.send("Input.insertText", { text: String(a.text ?? "") });
		if (a.enter) { await pressEnter(); await sleep(1500); }
		return snapshot("Typed into " + a.n + ".");
	}
	if (name === "browse_look") { const b = await br(), r = await b.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }); if (!r.result) throw new Error("Couldn't see the page."); return [{ type: "image", data: r.result.data, mimeType: "image/jpeg" }]; }
	if (name === "browse_login") {
		await settle();
		const loc = await inPage("({ host: location.hostname, proto: location.protocol })");
		if (loc.proto !== "https:" && !/^(localhost|127.0.0.1)$/.test(loc.host)) throw new Error("Logins are only filled on secure (https) pages.");
		const saved = vaultAll().filter((x) => fits(x.site, loc.host));
		if (!saved.length) return text("No login is saved for " + loc.host + ". Ask the user to add it under Plugins, then Passwords (it stays on their computer), and try again.");
		const x = saved[0];
		const userField = "(() => { const vis = " + VIS + "; const pw = [...document.querySelectorAll('input[type=password]')].find(vis); const scope = (pw && pw.form) || document; const c = [...scope.querySelectorAll(" + JSON.stringify(USER_SEL) + ")].filter(vis).filter((e) => !pw || (e.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING)); return c.length ? c[c.length - 1] : null; })()";
		const pwField = "[...document.querySelectorAll('input[type=password]')].find(" + VIS + ")";
		const b = await br();
		let hasPw = await inPage("!!(" + pwField + ")");
		// the username (pages that ask for it on its own first: then Enter, and the password on the next page)
		if (await focusField(userField)) await b.send("Input.insertText", { text: x.user });
		if (!hasPw) {
			await pressEnter(); await sleep(2500); await settle();
			hasPw = await inPage("!!(" + pwField + ")");
			if (!hasPw) return snapshot("Filled the username saved for " + x.site + ". The page hasn't asked for the password yet: a code or a choice may be on screen, which the user can do in the browser window.");
		}
		// still the site it was saved for, and the password field is what has the focus: only then is it typed
		if (!fits(x.site, await inPage("location.hostname"))) throw new Error("The page is no longer on " + x.site + ": nothing was filled.");
		if (!(await focusField(pwField)) || !(await inPage("(document.activeElement && document.activeElement.type) === 'password'"))) throw new Error("Couldn't put the cursor in the password field, so nothing was typed.");
		await b.send("Input.insertText", { text: unseal(x.secret) });
		await pressEnter();
		await sleep(2500);
		return snapshot("Signed in to " + x.site + " with the login saved on this computer (typed by the computer itself: it never reached you). If the site asks for a code, the user types it in the browser window.");
	}
	return null;
}

async function useComputer(name, a) {
	if (/^browse_/.test(name)) { const r = await browse(name, a); if (r) return r; }
	if (name === "run_command" || name === "start_command") {
		const child = shell(String(a.command || ""), a.cwd);
		if (name === "start_command") {
			const id = "job" + ++jobN, j = { child, out: "", read: 0, done: false, code: null };
			child.stdout.on("data", (d) => (j.out += d)); child.stderr.on("data", (d) => (j.out += d));
			child.on("close", (code) => { j.done = true; j.code = code; });
			child.on("error", (e) => { j.done = true; j.out += "\n" + e.message; });
			JOBS.set(id, j);
			await new Promise((r) => setTimeout(r, 1500));
			const first = j.out;
			j.read = first.length;
			return text("Started " + id + (j.done ? " (it already finished, exit code " + j.code + ")" : "") + ". So far:\n" + (cap(first, 8000) || "(nothing yet)"));
		}
		const limit = Math.min(3600, Math.max(5, Number(a.timeout_seconds) || 300)) * 1000;
		return new Promise((done) => {
			let out = "", late = false;
			const t = setTimeout(() => { late = true; kill(child); }, limit);
			child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
			child.on("error", (e) => { clearTimeout(t); done(text("It couldn't start: " + e.message)); });
			child.on("close", (code) => { clearTimeout(t); done(text(cap(out) + "\n(exit code " + code + (late ? ", stopped after " + limit / 1000 + "s" : "") + ")")); });
		});
	}
	if (name === "read_job" || name === "stop_job") {
		const j = JOBS.get(String(a.id));
		if (!j) return text("There's no job " + a.id + ".");
		if (name === "stop_job") { kill(j.child); return text("Stopped " + a.id + "."); }
		const fresh = j.out.slice(j.read);
		j.read = j.out.length;
		return text(cap(fresh, 30000) + (j.done ? "\n(finished, exit code " + j.code + ")" : "\n(still running)"));
	}
	if (name === "read_file") {
		const p = at(a.path), type = IMAGE[extname(p).toLowerCase()];
		if (type) return [{ type: "image", data: readFileSync(p).toString("base64"), mimeType: type }];
		const lines = readFileSync(p, "utf8").split(/\r?\n/), from = Math.max(1, Number(a.offset) || 1), n = Math.max(1, Number(a.limit) || 2000);
		return text(cap(lines.slice(from - 1, from - 1 + n).map((l, i) => String(from + i).padStart(6) + "\t" + l).join("\n"), 200000) + (lines.length > from - 1 + n ? "\n(" + lines.length + " lines in all)" : ""));
	}
	if (name === "write_file") {
		const p = at(a.path);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, String(a.content ?? ""));
		return text("Wrote " + p + " (" + String(a.content ?? "").split("\n").length + " lines).");
	}
	if (name === "edit_file") {
		const p = at(a.path), was = readFileSync(p, "utf8"), old = String(a.old_text ?? "");
		const n = old ? was.split(old).length - 1 : 0;
		if (!n) throw new Error("old_text isn't in " + p + " exactly as written. Read the file and copy it exactly.");
		if (n > 1 && !a.replace_all) throw new Error("old_text appears " + n + " times in " + p + ": give more of the text around it, or set replace_all.");
		writeFileSync(p, a.replace_all ? was.split(old).join(String(a.new_text ?? "")) : was.replace(old, () => String(a.new_text ?? "")));
		return text("Changed " + p + (n > 1 ? " (" + n + " places)" : "") + ".");
	}
	if (name === "list_files") {
		const root = at(a.path), re = a.pattern ? globRe(a.pattern) : null, out = [];
		walk(root, (p) => { const r = relative(root, p).replace(/\\/g, "/"); if (!re || re.test(r) || re.test(r.split("/").pop())) out.push(r); if (out.length >= 2000) return false; });
		return text(out.length ? out.join("\n") + (out.length >= 2000 ? "\n… (more: narrow it with a pattern)" : "") : "Nothing there matches.");
	}
	if (name === "search_files") {
		const root = at(a.path), re = new RegExp(String(a.regex), "i"), only = a.pattern ? globRe(a.pattern) : null, out = [];
		const look = (p) => {
			if (only && !only.test(p.split(/[\\/]/).pop())) return;
			let st;
			try { st = statSync(p); } catch { return; }
			if (st.size > 2e6 || IMAGE[extname(p).toLowerCase()]) return;
			let body;
			try { body = readFileSync(p, "utf8"); } catch { return; }
			if (body.includes("\u0000")) return;
			body.split(/\r?\n/).forEach((l, i) => { if (out.length < 300 && re.test(l)) out.push(relative(root, p).replace(/\\/g, "/") + ":" + (i + 1) + ": " + l.trim().slice(0, 300)); });
			if (out.length >= 300) return false;
		};
		if (statSync(root).isFile()) look(root); else walk(root, look);
		return text(out.length ? out.join("\n") : "No matches.");
	}
	if (name === "open") {
		const target = String(a.target || "");
		spawn(WIN ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open", WIN ? ["/c", "start", "", target] : [target], { detached: true, stdio: "ignore", windowsHide: true }).unref();
		return text("Opened " + target + ".");
	}
	if (name === "screenshot") {
		if (!WIN) throw new Error("Screenshots work on Windows for now.");
		const file = join(tmpdir(), "andromeda-screen-" + Date.now() + ".jpg");
		const ps = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $m=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($m); $g.CopyFromScreen($b.Left,$b.Top,0,0,$m.Size); $w=[Math]::Min(1600,$b.Width); $s=New-Object System.Drawing.Bitmap $m,$w,([int]($b.Height*$w/$b.Width)); $s.Save('" + file.replace(/'/g, "''") + "',[System.Drawing.Imaging.ImageFormat]::Jpeg)";
		await new Promise((done) => { const c = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true }); c.on("close", done); c.on("error", done); });
		if (!existsSync(file)) throw new Error("Couldn't take the screenshot.");
		return [{ type: "image", data: readFileSync(file).toString("base64"), mimeType: "image/jpeg" }];
	}
	throw new Error("There's no tool called " + name + ".");
}
async function computer(msg) {
	if (msg.id == null) return null;
	const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
	if (msg.method === "initialize") return ok({ protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "computer", version: "1" } });
	if (msg.method === "ping") return ok({});
	if (msg.method === "tools/list") return ok({ tools: COMPUTER.map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: "object", properties, required } })) });
	if (msg.method === "tools/call") {
		try { return ok({ content: await useComputer(msg.params.name, msg.params.arguments || {}) }); }
		catch (e) { return ok({ content: text(String(e.message || e)), isError: true }); }
	}
	return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Not supported" } };
}
