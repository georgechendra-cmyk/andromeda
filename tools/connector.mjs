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
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
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
	const out = {};
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
