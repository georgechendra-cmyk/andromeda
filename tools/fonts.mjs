// Celestin's typefaces: every family on Google Fonts, with Google's own tags for how each one feels (calm, playful,
// sophisticated, vintage...), its themes (art deco, pixel, blackletter...) and seasons (Christmas, Lunar New Year...), how
// well it's made (Google's quality scores), whether it can set text or only headings, and which scripts it has. So a
// typeface is chosen for the occasion from evidence, from all of them, never from a short list or a habit.
//   node tools/fonts.mjs <families.csv> <metadata.json>   (writes fonts.json next to index.html)
// The two inputs are Google's: github.com/google/fonts (tags/all/families.csv) and fonts.google.com/metadata/fonts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const [csvPath, metaPath] = process.argv.slice(2);
// (the typefaces every AI reaches for: never offered, so never the default)
const GENERIC = /^(inter|inter tight|roboto|roboto flex|arial|helvetica|open sans|lato|poppins|montserrat|space grotesk|dm sans|manrope|plus jakarta sans|outfit|sora|geist|geist mono|instrument sans|instrument serif|playfair display|playfair)$/i;
const meta = JSON.parse(readFileSync(metaPath, "utf8").replace(/^\)\]\}'\s*/, "")).familyMetadataList;
// each tag at its strongest across the family's weights
const tags = new Map();
for (const line of readFileSync(csvPath, "utf8").split(/\r?\n/)) {
	const m = line.match(/^"?(.+?)"?,[^,]*,(\/[^,]+),(\d+(?:\.\d+)?)\s*$/);
	if (!m) continue;
	const t = tags.get(m[1]) || {};
	t[m[2]] = Math.max(t[m[2]] || 0, Number(m[3]));
	tags.set(m[1], t);
}
const shortTag = (t) => {
	const [, group, name] = t.split("/");
	const n = name.toLowerCase();
	if (group === "Expressive" || group === "Theme" || group === "Seasonal" || group === "Purpose") return n;
	if (group === "Script") return /script/.test(n) ? n : n + " script";
	if (group === "Sans" || group === "Serif" || group === "Slab") return n + " " + group.toLowerCase();
	if (group === "Monospace") return "monospace";
	return "";
};
const SCRIPTS = { cyrillic: "cyr", greek: "grk", vietnamese: "vie", arabic: "ara", hebrew: "heb", thai: "tha", devanagari: "dev", japanese: "jpn", korean: "kor", "chinese-simplified": "zhs", "chinese-traditional": "zht", "chinese-hongkong": "zhh" };
const CAT = { "Sans Serif": "sans", Serif: "serif", Display: "display", Handwriting: "handwriting", Monospace: "mono" };
const out = [];
for (const f of meta) {
	if (f.isNoto || GENERIC.test(f.family) || /\b(icons?|symbols?|emoji)\b/i.test(f.family) || (f.colorCapabilities || []).length) continue;
	const cat = CAT[f.category] || "display";
	const t = tags.get(f.family) || {};
	const quality = ["/Quality/Concept", "/Quality/Drawing", "/Quality/Spacing", "/Quality/Wordspace"].map((k) => t[k]).filter((x) => x != null);
	const feel = Object.entries(t).filter(([k, w]) => !/^\/Quality\//.test(k) && w >= 30).map(([k, w]) => [shortTag(k), Math.round(w)]).filter(([k]) => k).sort((a, b) => b[1] - a[1]).slice(0, 8);
	// (sets text too: a sans, serif or mono with a real range of weights; a display or handwriting face: headings only)
	const weights = new Set(Object.keys(f.fonts || {}).filter((k) => !/i$/.test(k)));
	const wght = (f.axes || []).find((a) => a.tag === "wght");
	const ranged = wght ? wght.max - wght.min >= 300 : weights.size >= 3 || (weights.has("400") && weights.has("700"));
	const use = (cat === "sans" || cat === "serif" || cat === "mono") && ranged ? "b" : "d";
	const scripts = (f.subsets || []).map((s) => SCRIPTS[s]).filter(Boolean);
	// (made first for another script, with Latin letters added: kept for that script, never offered for Latin text)
	const primary = f.primaryScript && f.primaryScript !== "Latn" ? f.primaryScript : "";
	out.push([f.family, cat, use, quality.length ? Math.round(quality.reduce((a, b) => a + b, 0) / quality.length) : 0, f.popularity || 9999, (f.subsets || []).includes("latin") ? 1 : 0, scripts.join(" "), feel.map(([k, w]) => k + " " + w).join(", "), primary]);
}
out.sort((a, b) => a[4] - b[4]);
const dest = fileURLToPath(new URL("../fonts.json", import.meta.url));
writeFileSync(dest, JSON.stringify({ made: new Date().toISOString().slice(0, 10), from: "Google Fonts: github.com/google/fonts tags/all/families.csv and fonts.google.com/metadata/fonts", cols: ["name", "category", "use", "quality", "popularity", "latin", "scripts", "feel", "primary"], fonts: out }));
console.log(out.length + " typefaces, " + out.filter((x) => x[7]).length + " with Google's feel tags -> " + dest);
