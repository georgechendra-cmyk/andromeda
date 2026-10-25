// Andromeda as an app: it installs (home screen, desktop) and opens without a connection.
// The page itself always comes fresh from the network when there is one, so an update shows up straight away; the copy
// kept here is only for when there's no connection. The libraries it loads from the CDNs are each a fixed version, so
// they're kept once fetched. Nothing else is touched: every request to the credits server and the models goes straight
// through, never cached.
const SHELL = "andromeda-shell-v1";
const LIBS = "andromeda-libs-v1";

self.addEventListener("install", (e) => {
	e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["./", "./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
	e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== LIBS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
	const req = e.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	// the page: the network first, the kept copy when offline
	if (req.mode === "navigate") {
		e.respondWith(
			fetch(req)
				.then((res) => {
					if (res.ok) {
						const copy = res.clone();
						caches.open(SHELL).then((c) => c.put("./", copy));
					}
					return res;
				})
				.catch(() => caches.match("./").then((hit) => hit || Response.error())),
		);
		return;
	}
	// the libraries (marked, DOMPurify, highlight.js, KaTeX, mermaid, the fonts): a fixed version never changes
	if (/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//.test(req.url)) {
		e.respondWith(
			caches.open(LIBS).then((c) =>
				c.match(req).then((hit) => hit || fetch(req).then((res) => {
					if (res.ok || res.type === "opaque") c.put(req, res.clone());
					return res;
				})),
			),
		);
		return;
	}
	// its own icons and manifest: what's kept at once, refreshed behind it
	if (url.origin === self.location.origin && /\/(icons\/[^/]+|manifest\.webmanifest)$/.test(url.pathname)) {
		e.respondWith(
			caches.open(SHELL).then((c) =>
				c.match(req).then((hit) => {
					const net = fetch(req).then((res) => {
						if (res.ok) c.put(req, res.clone());
						return res;
					}).catch(() => hit || Response.error());
					return hit || net;
				}),
			),
		);
	}
});
