// Builds together.html (Celestin Together, its own app) from index.html: the same code, marked as the Together app, with
// its own title and install manifest. Run before every publish (publish.sh does), so the two never drift apart.
import { readFileSync, writeFileSync } from "node:fs";
const dir = new URL("../", import.meta.url);
let s = readFileSync(new URL("index.html", dir), "utf8");
const swap = (a, b) => { if (!s.includes(a)) throw new Error("build-together: not found: " + a.slice(0, 60)); s = s.replace(a, b); };
swap('<html lang="en">', '<html lang="en" data-app="together">');
s = s.replace(/<title>[^<]*<\/title>/, "<title>Celestin Together — your AI team</title>");
s = s.replace(/(<meta property="og:title" content=")[^"]*"/, '$1Celestin Together: your AI team, every part by whoever does it best"');
s = s.replace(/(<meta name="twitter:title" content=")[^"]*"/, '$1Celestin Together: your AI team, every part by whoever does it best"');
swap('<link rel="manifest" href="manifest.webmanifest">', '<link rel="manifest" href="together.webmanifest">');
writeFileSync(new URL("together.html", dir), s);
console.log("together.html built");
