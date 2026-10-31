// Epoch AI's benchmarking hub (epoch.ai/benchmarks, CC BY 4.0): what each model can actually do, measured by tests that
// check the answer (code that passes, maths that's right, facts that are true), not by which answer people preferred.
// tools/arena.mjs turns it into boards beside LMArena's, in the Epoch Capabilities Index's own points:
//   bench:overall   the Epoch Capabilities Index (ECI): one number from over fifty benchmarks
//   bench:code, bench:math, bench:science, bench:facts, bench:agents, bench:reasoning
//     the model's ECI, moved by how much better or worse than that ECI predicts it does on that field's own benchmarks
//     (the more of them agree, the further it moves). A model with none of them isn't on that board.
// and verbosity: how much each model writes per step of real coding work, against the others at the same effort (what
// a model costs per answer depends on how long it thinks, not only on its price per token).

// a CSV file (quoted fields with commas, quotes and line breaks in them) as objects
export function csv(text) {
	const rows = [];
	let row = [], f = "", q = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (q) {
			if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
			else f += c;
		} else if (c === '"') q = true;
		else if (c === ",") { row.push(f); f = ""; }
		else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
		else f += c;
	}
	if (f || row.length) { row.push(f); rows.push(row); }
	const head = rows.shift() || [];
	return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, k) => [h, r[k]])));
}

// each field, and the benchmarks that measure it: [file, score column, how its scores read]
// (p: a share right, 0 to 1; pct: a percentage; raw: a score where more is better; log: a length of time)
const DOMAINS = {
	code: [
		["frontiercode_external.csv", "Main score", "p"],
		["cursorbench_external.csv", "Score", "p"],
		["frontierswe_external.csv", "Score", "p"],
		["deepswe_external.csv", "Pass@1", "p"],
		["swe_bench_verified.csv", "Best score (across scorers)", "p"],
		["terminalbench_external.csv", "Accuracy mean", "p"],
		["aider_polyglot_external.csv", "Percent correct", "pct"],
		["weirdml_v3_external.csv", "Score", "p"],
		["mirrorcode.csv", "Best score (across scorers)", "p"],
		["scicode_external.csv", "Score", "p"],
		["gso_external.csv", "Score OPT@1", "p"],
		["ale_bench_external.csv", "Performance", "raw"],
	],
	math: [
		["otis_mock_aime_2024_2025.csv", "Best score (across scorers)", "p"],
		["frontiermath_tiers_1_3_v2.csv", "Best score (across scorers)", "p"],
		["frontiermath_tier_4_v2.csv", "Best score (across scorers)", "p"],
		["proofbench_external.csv", "Accuracy", "p"],
		["frontiermath_erdos.csv", "Best score (across scorers)", "p"],
	],
	science: [
		["gpqa_diamond.csv", "Best score (across scorers)", "p"],
		["critpt_external.csv", "Accuracy", "p"],
		["hle_external.csv", "Accuracy", "p"],
	],
	facts: [["simpleqa_verified.csv", "Best score (across scorers)", "p"]],
	agents: [
		["apex_agents_external.csv", "Pass@1 score", "p"],
		["vending_bench_2_external.csv", "Score", "raw"],
		["osworld_2_external.csv", "Binary accuracy", "p"],
		["rli_external.csv", "Score", "p"],
		["gdp_pdf_external.csv", "GDP.pdf score", "p"],
		["metr_time_horizons_external.csv", "Time horizon", "log"],
	],
	reasoning: [
		["arc_agi_2_external.csv", "Score", "p"],
		["simplebench_external.csv", "Score (AVG@5)", "p"],
		["mystery_game_puzzles.csv", "Best score (across scorers)", "p"],
		["chess_puzzles.csv", "Best score (across scorers)", "p"],
		["enigma_eval_external.csv", "Accuracy", "p"],
	],
};
const EFFORTS = /_(max|xhigh|high|medium|low|minimal|none|unknown)$/;
// how hard a row's model was told to think: the end of its version ("claude-opus-5-5_high"), or the benchmark's own
// column for it ("Extra High")
const LEVEL = { max: "max", "extra high": "xhigh", xhigh: "xhigh", high: "high", medium: "medium", low: "low", minimal: "minimal", none: "none" };
function effortIn(r, version) {
	const m = String(version).match(EFFORTS);
	if (m && m[1] !== "unknown") return m[1];
	for (const k of ["Reasoning effort", "Reasoning level", "Reasoning"]) { const v = LEVEL[String(r[k] || "").trim().toLowerCase()]; if (v) return v; }
	return "";
}
// how far a model's strength in one field can stray from its general ability, in ECI points: it takes several
// benchmarks agreeing to move a model a long way; and the same for what an effort level changes
const TAU = 4, EFFORT_TAU = 3;

// read(file): a file's text from the unzipped data (null if it isn't there)
export function epochBoards(read) {
	const meta = csv(read("model_metadata.csv") || "");
	const group = new Map(), orgs = new Map();
	for (const r of meta) if (r.model_version) { group.set(r.model_version, r.model_group || r.display_name || r.model_version); orgs.set(r.model_group, r.organization || ""); }
	const nameOf = (v) => group.get(v) || group.get(String(v).replace(EFFORTS, "")) || String(v).replace(EFFORTS, "");
	const scale = new Map();
	for (const r of csv(read("benchmark_metadata.csv") || "")) scale.set(r.source_file, { base: Number(r.random_baseline) || 0, ceil: Number(r.score_ceiling) || 1 });
	// the Epoch Capabilities Index, and its 95% interval
	const eci = new Map();
	for (const r of csv(read("epoch_capabilities_index/eci_scores.csv") || "")) {
		const v = Number(r.eci), lo = Number(r.eci_ci_low), hi = Number(r.eci_ci_high);
		if (!r.Model || !Number.isFinite(v)) continue;
		eci.set(r.Model, { v, hw: Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? (hi - lo) / 2 : 3, org: r.Organization || "" });
	}
	if (eci.size < 20) return null;
	// every model with an ECI is kept, so a model missing from it is one Epoch hasn't run at all
	const out = { cats: {}, used: {}, verbosity: [], efforts: {} };
	out.cats["bench:overall"] = [...eci].sort((a, b) => b[1].v - a[1].v).map(([n, e]) => [n, e.org, +e.v.toFixed(2), +e.hw.toFixed(2), 0]);
	const logit = (p) => Math.log(p / (1 - p));
	// how much less a model gets right at each effort than at its best, in ECI points, field by field and over all
	// (evidence from every benchmark that ran the same model at several efforts)
	const curves = { all: new Map() };
	const addCurve = (domain, n, f, d, w) => {
		for (const c of [curves[domain] || (curves[domain] = new Map()), curves.all]) {
			if (!c.has(n)) c.set(n, new Map());
			const e = c.get(n);
			if (!e.has(f)) e.set(f, { s: 0, w: 0, n: 0 });
			const a = e.get(f);
			a.s += d * w; a.w += w; a.n++;
		}
	};
	for (const [domain, list] of Object.entries(DOMAINS)) {
		// each model's residuals on this field's benchmarks, in ECI points, with how noisy each benchmark is
		const per = new Map();
		out.used[domain] = [];
		for (const [file, col, kind] of list) {
			const rows = csv(read(file) || "");
			if (!rows.length || !(col in rows[0])) continue;
			const mcol = Object.keys(rows[0]).find((k) => /^model version$/i.test(k)) || Object.keys(rows[0])[0];
			const sc = scale.get(file) || { base: 0, ceil: 1 };
			const tr = (v) => {
				if (kind === "raw") return v;
				if (kind === "log") return v > 0 ? Math.log(v) : null;
				const q = ((kind === "pct" ? v / 100 : v) - sc.base) / ((sc.ceil || 1) - sc.base);
				return logit(Math.min(0.99, Math.max(0.01, q)));
			};
			// each model's best, whatever effort or harness it was run with (as the ECI is), and its best at each effort
			const best = new Map(), byEff = new Map();
			for (const r of rows) {
				const v = Number(r[col]);
				if (!r[mcol] || r[col] === "" || !Number.isFinite(v)) continue;
				const n = nameOf(r[mcol]);
				if (!best.has(n) || v > best.get(n)) best.set(n, v);
				const f = effortIn(r, r[mcol]);
				if (f) {
					if (!byEff.has(n)) byEff.set(n, new Map());
					const m = byEff.get(n);
					if (!m.has(f) || v > m.get(f)) m.set(f, v);
				}
			}
			const x = new Map();
			for (const [n, v] of best) { const t = tr(v); if (t != null) x.set(n, t); }
			// how the benchmark rises with general ability: a straight line through every model with an ECI
			const pts = [...x].filter(([n]) => eci.has(n)).map(([n, t]) => [eci.get(n).v, t]);
			if (pts.length < 6) continue;
			const mc = pts.reduce((s, p) => s + p[0], 0) / pts.length, mx = pts.reduce((s, p) => s + p[1], 0) / pts.length;
			let sxy = 0, sxx = 0, syy = 0;
			for (const [c, t] of pts) { sxy += (c - mc) * (t - mx); sxx += (c - mc) ** 2; syy += (t - mx) ** 2; }
			const k = sxy / sxx, a = mx - k * mc, r = sxy / Math.sqrt(sxx * syy);
			// a benchmark that doesn't rise with ability says nothing about it
			if (!(k > 0) || !(r >= 0.4)) continue;
			const res = pts.map(([c, t]) => (t - a - k * c) / k);
			const sigma = Math.max(1.5, Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length));
			out.used[domain].push(file.replace(/(_external)?\.csv$/, "") + " (" + pts.length + " models, r " + r.toFixed(2) + ")");
			for (const [n, t] of x) {
				const e = eci.get(n);
				if (!per.has(n)) per.set(n, []);
				per.get(n).push({ v: e ? (t - a - k * e.v) / k : (t - a) / k, sigma });
			}
			// the same model at several efforts: what each gives up against its best one, in ECI points
			for (const [n, m] of byEff) {
				if (m.size < 2) continue;
				const ts = [...m].map(([f, v]) => [f, tr(v)]).filter(([, t]) => t != null);
				if (ts.length < 2) continue;
				const top = Math.max(...ts.map(([, t]) => t));
				for (const [f, t] of ts) addCurve(domain, n, f, (t - top) / k, 1 / sigma ** 2);
			}
		}
		const rows = [];
		for (const [n, list] of per) {
			const e = eci.get(n);
			const prec = list.reduce((s, x) => s + 1 / x.sigma ** 2, 0);
			if (e) {
				// its general ability, moved toward what this field's benchmarks say
				const off = list.reduce((s, x) => s + x.v / x.sigma ** 2, 0) / (prec + 1 / TAU ** 2);
				const sd = 1 / Math.sqrt(prec + 1 / TAU ** 2);
				rows.push([n, e.org, +(e.v + off).toFixed(2), +Math.hypot(0.6 * e.hw, 1.96 * sd).toFixed(2), list.length]);
			} else if (list.length >= 2) {
				// no ECI: what these benchmarks alone say, held to a wider margin
				const v = list.reduce((s, x) => s + x.v / x.sigma ** 2, 0) / prec;
				rows.push([n, orgs.get(n) || "", +v.toFixed(2), +(1.96 / Math.sqrt(prec) + 2).toFixed(2), list.length]);
			}
		}
		if (rows.length >= 6) out.cats["bench:" + domain] = rows.sort((a, b) => b[2] - a[2]).slice(0, 150);
	}
	// verbosity: the tokens a model writes per step of agentic coding, against the middle of the models run at the same
	// effort on the same benchmark; each model's typical ratio (geometric mean)
	const ratios = new Map();
	for (const [file, tok, steps, eff] of [["cursorbench_external.csv", "Tokens per task", "Steps per task", "Reasoning level"], ["deepswe_external.csv", "Mean output tokens", "Mean agent steps", "Reasoning effort"]]) {
		const by = new Map();
		for (const r of csv(read(file) || "")) {
			const t = Number(r[tok]), s = Number(r[steps]);
			if (!(t > 0) || !(s > 0) || !r["Model version"]) continue;
			const level = String((String(r["Model version"]).match(EFFORTS) || [])[1] || r[eff] || "").toLowerCase().replace(/^extra high$/, "xhigh");
			if (!by.has(level)) by.set(level, []);
			by.get(level).push([nameOf(r["Model version"]), t / s]);
		}
		for (const list of by.values()) {
			if (list.length < 4) continue;
			const sorted = list.map((x) => x[1]).sort((a, b) => a - b);
			const mid = sorted[Math.floor(sorted.length / 2)];
			for (const [n, v] of list) { if (!ratios.has(n)) ratios.set(n, []); ratios.get(n).push(v / mid); }
		}
	}
	for (const [n, list] of ratios) out.verbosity.push([n, +Math.exp(list.reduce((s, v) => s + Math.log(v), 0) / list.length).toFixed(2), list.length]);
	out.verbosity.sort((a, b) => b[1] - a[1]);
	// what thinking buys each model, field by field: each effort's points below its best effort (0 at the best), held
	// toward no difference until several benchmarks agree (a benchmark that barely rises with ability turns a few points
	// of noise into a big gap)
	for (const [domain, c] of Object.entries(curves)) {
		const rows = [];
		for (const [n, m] of c) {
			if (m.size < 2) continue;
			const d = Object.fromEntries([...m].map(([f, a]) => [f, a.s / (a.w + 1 / EFFORT_TAU ** 2)]));
			// thinking less never measures better than thinking more, up to high (different benchmarks ran different
			// efforts, which can make "minimal" look better than "low"); past high, more can genuinely do worse
			let floor = Infinity;
			for (const f of ["high", "medium", "low", "minimal", "none"]) if (f in d) floor = d[f] = Math.min(d[f], floor);
			const top = Math.max(...Object.values(d));
			rows.push([n, Object.fromEntries(Object.entries(d).map(([f, v]) => [f, +(v - top).toFixed(2)])), Math.max(...[...m.values()].map((a) => a.n))]);
		}
		if (rows.length) out.efforts[domain] = rows;
	}
	return out;
}
