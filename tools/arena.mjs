// Builds arena.json: how every model actually scores, kind of work by kind of work, from LMArena's public leaderboards
// (huggingface.co/datasets/lmarena-ai/leaderboard-dataset, refreshed by LMArena every few days: which answer people
// preferred) and Epoch AI's benchmarking hub (epoch.ai/benchmarks: whether the answer was right). Andromeda reads it to
// pick the best model for each request's exact mix of work. Run daily by .github/workflows/arena.yml:
//   npm install hyparquet fflate && node tools/arena.mjs arena.json
import { writeFileSync } from "node:fs";
import { parquetReadObjects } from "hyparquet";
import { unzipSync, strFromU8 } from "fflate";
import { epochBoards } from "./epoch.mjs";

const BASE = "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/";
// leaderboard (style-controlled where LMArena offers it, as their own site shows) → its name in arena.json
const BOARDS = {
	text_style_control: "text",
	text_factuality: "factuality",
	webdev: "webdev",
	vision_style_control: "vision",
	search_style_control: "search",
	document_style_control: "document",
	search_factuality: "searchfact",
	agent: "agent",
	// how agents behave over a long job (every one of these: higher is better)
	agent_task_outcome_explicit: "agent_outcome",
	agent_tool_hallucination: "agent_honest_tools",
	agent_bash_reliability: "agent_reliability",
	agent_bash_reliability_no_prereq: "agent_reliability_cold",
	agent_bash_recovery_steps: "agent_recovery",
	agent_steerability: "agent_steerability",
	agent_praise_complaint: "agent_satisfaction",
	// the studio: pictures by kind (photorealistic, portraits, art, cartoon, text in the image...), edits, and video
	text_to_image: "image",
	image_edit: "imageedit",
	text_to_video: "video",
	image_to_video: "i2v",
	video_edit: "videoedit",
};
// the best this many of each category are kept: enough to cover every model a request could go to
const KEEP = 60;

const out = { updated: new Date().toISOString(), source: "LMArena leaderboard-dataset (huggingface.co/datasets/lmarena-ai/leaderboard-dataset)", published: {}, cats: {} };
for (const [config, name] of Object.entries(BOARDS)) {
	const r = await fetch(BASE + config + "/latest-00000-of-00001.parquet");
	if (!r.ok) {
		console.error(config + ": " + r.status);
		continue;
	}
	const rows = await parquetReadObjects({ file: await r.arrayBuffer() });
	const byCat = new Map();
	for (const x of rows) {
		// Elo boards have rating and its 95% interval; the agent board has a score in its place
		const value = x.rating ?? x.score;
		const lower = x.rating_lower ?? x.score_ci_lower;
		if (value == null || !x.model_name) continue;
		if (!byCat.has(x.category)) byCat.set(x.category, []);
		byCat.get(x.category).push([String(x.model_name), String(x.organization || ""), +Number(value).toFixed(4), +Number(value - (lower ?? value)).toFixed(4), Number(x.vote_count ?? x.session_count ?? 0)]);
		if (x.leaderboard_publish_date) out.published[name] = String(x.leaderboard_publish_date);
	}
	for (const [cat, list] of byCat) {
		list.sort((a, b) => b[2] - a[2]);
		out.cats[name + ":" + cat] = list.slice(0, KEEP);
	}
	console.log(config + ": " + rows.length + " rows, " + byCat.size + " categories");
}
if (!Object.keys(out.cats).length) throw new Error("no leaderboards could be read");
// Epoch AI's benchmarks (CC BY 4.0, credited here and on the site): code that passes its tests, maths that's right,
// facts that are true, agents that finish; and how much each model really thinks. Without them the boards above still
// route on their own
try {
	const r = await fetch("https://epoch.ai/data/benchmark_data.zip");
	if (!r.ok) throw new Error("HTTP " + r.status);
	const files = unzipSync(new Uint8Array(await r.arrayBuffer()));
	const read = (name) => { const k = Object.keys(files).find((p) => p === name || p.endsWith("/" + name)); return k ? strFromU8(files[k]) : null; };
	const ep = epochBoards(read);
	if (!ep) throw new Error("no Epoch Capabilities Index in it");
	Object.assign(out.cats, ep.cats);
	out.verbosity = ep.verbosity;
	out.efforts = ep.efforts;
	out.published.bench = new Date(r.headers.get("last-modified") || Date.now()).toISOString().slice(0, 10);
	out.source += "; Epoch AI, 'Capabilities & benchmarking' (epoch.ai/benchmarks, CC BY 4.0)";
	for (const [k, v] of Object.entries(ep.used)) console.log("epoch " + k + ": " + v.join(", "));
	console.log("epoch: " + Object.keys(ep.cats).length + " boards, verbosity for " + ep.verbosity.length + " models");
} catch (e) {
	console.error("epoch: " + e.message);
}
writeFileSync(process.argv[2] || "arena.json", JSON.stringify(out));
console.log("wrote " + Object.keys(out.cats).length + " categories");
