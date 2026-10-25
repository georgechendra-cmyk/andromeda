// Andromeda Connector: the apps on this computer, for Andromeda in your browser.
//
// Any MCP server (the same ones Claude Desktop uses: Blender, Figma, Unity, your files, GitHub, a database...) runs here,
// and Andromeda talks to it over http://127.0.0.1:8765. Servers come from connections.json beside this file and, if you
// use Claude Desktop, from its own config, so whatever you've set up for Claude works in Andromeda too.
//
//   node tools/connector.mjs            (or double-click "CONNECT APPS.bat")
//
// connections.json looks like Claude Desktop's:
//   { "mcpServers": { "blender": { "command": "uvx", "args": ["blender-mcp"] },
//                     "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/me/Documents"] },
//                     "some-online-one": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } } } }
//
// Only Andromeda can use it: it listens on this computer alone, answers only Andromeda's own pages, and wants the
// pairing code it prints (paste it into Andromeda once, under Connect apps).
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANDROMEDA_CONNECTOR_PORT || 8765);
const ORIGINS = [/^https:\/\/georgechendra-cmyk\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, /^null$/, ...(process.env.ANDROMEDA_ORIGINS || "").split(",").filter(Boolean).map((o) => new RegExp("^" + o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"))];

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
			// the server asking Andromeda something (roots, sampling): not offered, said so, so it never waits forever
			else if (m.id != null && m.method) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Not supported by Andromeda" } }) + "\n");
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
	if (!allowed) return send(403, { error: "Only Andromeda can use this connector." });
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
	console.log("\n  Andromeda Connector is on. Leave this window open while you use Andromeda.\n");
	console.log("  Pairing code (paste it into Andromeda, under Connect apps):  " + CODE + "\n");
	console.log("  Apps: " + (names.length ? names.join(", ") : "none yet. Add them to tools/connections.json (see connections.example.json)") + "\n");
});

// ------------------------------------------------------------------ this computer itself
// What an engineer at this computer does: run commands and programs (and keep long ones going in the background), read,
// write and edit files, find and search them, open things, and look at the screen. Andromeda asks the user before
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
async function useComputer(name, a) {
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
