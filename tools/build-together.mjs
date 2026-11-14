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
s = s.split("docs/og.png").join("docs/og-together.png");
s = s.replace(/(<meta property="og:image:alt" content=")[^"]*"/, '$1Celestin Together: your AI team, each the model measured best at its job."');
s = s.replace(/(<meta name="description" content=")[^"]*"/, '$1Celestin Together: six AI teammates in one chat, each the model measured best at their job. They split the work, do it at the same time, and check it."');
s = s.replace(/(<meta property="og:description" content=")[^"]*"/, '$1Six AI teammates in one chat, each the model measured best at their job. They split the work, do it at the same time, and check it."');
// its own mark and icons: the same orbit with a moon at each tip
s = s.split('href="#logo"').join('href="#logoT"');
s = s.replace('<link rel="icon" href="icons/icon.svg" type="image/svg+xml">', '<link rel="icon" href="icons/together.svg" type="image/svg+xml">');
s = s.replace('<link rel="icon" href="icons/icon-192.png" type="image/png" sizes="192x192">', '<link rel="icon" href="icons/together-192.png" type="image/png" sizes="192x192">');
s = s.replace('<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">', '<link rel="apple-touch-icon" href="icons/together-touch.png">');
s = s.replace('<svg class="mark"><use href="#logoT"/></svg>Celestin</button></header>', '<svg class="mark"><use href="#logoT"/></svg>Celestin Together</button></header>');
s = s.replace('<footer class="auth-foot">Free credits every day · no card · your chats stay in your browser</footer>', '<footer class="auth-foot">Free to start · no card · no subscription · made by Celestin</footer>');
// a workplace, not a chat (the owner, Nov 14): its "+" makes an agent, its sidebar is the team, its own typefaces
swap('id="newChat" data-tip="New chat · Ctrl K" aria-label="New chat"', 'id="newChat" data-tip="New agent" aria-label="New agent"');
swap('id="newChatTop" aria-label="New chat"', 'id="newChatTop" aria-label="New agent"');
swap("<!-- your chats and projects:", '<div class="tg-team" id="tgTeam" aria-label="Your team"></div>\n\t\t<!-- your chats and projects:');
swap("</head>", '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=DM+Sans:opsz,wght@9..40,400..700&display=swap">\n</head>');
writeFileSync(new URL("together.html", dir), s);
console.log("together.html built");
