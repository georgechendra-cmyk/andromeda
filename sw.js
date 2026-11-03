// Celestin as an app: it installs (home screen, desktop) and opens without a connection, and quickly on a weak one.
// The page (and the leaderboards it routes by) comes fresh from the network when that answers within a few seconds, so an
// update shows up straight away; on a weak connection the copy kept here opens instead, and the fresh one, still coming,
// is kept for next time; with no connection, the kept one. Each page is kept as itself (the Terms are never kept as the
// app). The libraries it loads from the CDNs are each a fixed version, so they're kept once fetched. Nothing else is
// touched: every request to the credits server and the models goes straight through, never cached.
const SHELL = "andromeda-shell-v2";
const SLOW_MS = 3000;
const LIBS = "andromeda-libs-v1";

self.addEventListener("install", (e) => {
	e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["./", "./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
	e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== LIBS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// fresh from the network, unless it's slow (then the copy kept under key, if there is one) or gone (then the kept copy,
// or fallback's); what the network brings is kept either way
function freshOrKept(e, key, fallback) {
	const net = fetch(e.request);
	// (the copy is taken at once, before the page starts reading what came)
	e.waitUntil(net.then((res) => {
		if (!res.ok || res.type !== "basic") return null;
		const copy = res.clone();
		return caches.open(SHELL).then((c) => c.put(key, copy));
	}).catch(() => {}));
	e.respondWith(new Promise((resolve) => {
		let done = false;
		const give = (r) => { if (!done && r) { done = true; resolve(r); } };
		const slow = setTimeout(() => caches.match(key).then(give, () => {}), SLOW_MS);
		net.then((res) => { clearTimeout(slow); give(res); }, () => {
			clearTimeout(slow);
			caches.match(key).then((hit) => hit || (fallback ? caches.match(fallback) : null)).then((hit) => give(hit || Response.error()), () => give(Response.error()));
		});
	}));
}

self.addEventListener("fetch", (e) => {
	const req = e.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	// a page: the app is kept as "./", any other page under its own path (with no connection and no copy of it: the app)
	if (req.mode === "navigate") {
		freshOrKept(e, /\/(index\.html)?$/.test(url.pathname) ? "./" : url.pathname.replace(/\.html$/, ""), "./");
		return;
	}
	// the leaderboards the routing reads (refreshed daily): the same way
	if (url.origin === self.location.origin && /\/arena\.json$/.test(url.pathname)) {
		freshOrKept(e, url.pathname, null);
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
