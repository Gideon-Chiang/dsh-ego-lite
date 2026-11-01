/**
 * Regression harness for ego_app_pointer's coordinate/selector handling.
 *
 * The bug this locks down: mouse_click accepted a snapshot ref (@N), a loc= or
 * an xpath= selector, silently dropped it, and clicked (0,0) while returning
 * ok:true — a real click on a real page header.
 *
 * Opt-in: needs the ego lite app running, past onboarding.
 *   node test/pointer-selector.mjs
 */
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";

const tools = new Map();
apply({ tools: { register: (tool) => tools.set(tool.name, tool) }, systemPrompt: { section: () => {} } }, {
	executable: "auto", timeoutMs: 180000, maxOutputBytes: 1048576, announceToAgent: false
});
const call = (name, args = {}) => tools.get(name).execute(args, {});

const fixtureUrl = new URL("./fixtures/interaction.html", import.meta.url);
const results = [];
const check = (label, ok, detail) => {
	results.push({ label, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${JSON.stringify(detail).slice(0, 220)}` : ""}`);
};

const opened = await call("ego_app_space", { action: "open", name: "pointer-回归" });
if (!opened.ok) {
	console.error("cannot open a TaskSpace:", opened.error);
	process.exit(1);
}
const name = "pointer-回归";
const nav = await call("ego_app_navigate", { name, url: fileURLToPath(fixtureUrl) === "" ? "" : `file:///${fileURLToPath(fixtureUrl).replace(/\\/g, "/")}` });
if (!nav.ok) {
	console.error("cannot open the fixture:", nav.error);
	process.exit(1);
}

const readState = async () => (await call("ego_app_js", {
	name,
	expression: "JSON.stringify({ clicks: window.__clicks || [], count: document.getElementById('clickCount').textContent })"
})).value ?? "";

const clicksOf = (state) => {
	try { return JSON.parse(state).clicks ?? []; } catch { return []; }
};
const clickCountOf = (state) => {
	try { return Number(JSON.parse(state).count); } catch { return -1; }
};

// ── refs and locators must fail loudly, not click (0,0) ─────────────────────
for (const selector of ["@1", "ref=1", "loc=css:#target", "xpath=//button", "text=click target"]) {
	const before = await readState();
	const out = await call("ego_app_pointer", { action: "mouse_click", name, selector });
	const after = await readState();
	const clickedAtZero = clicksOf(after).some((entry) => entry.x === 0 && entry.y === 0);
	check(
		`mouse_click rejects ${selector} instead of clicking (0,0)`,
		out.ok === false && !clickedAtZero && clickCountOf(after) === clickCountOf(before),
		{ ok: out.ok, error: String(out.error ?? "").slice(0, 120), clickedAtZero, clicks: clicksOf(after).length }
	);
}

// A ref plus explicit coordinates must not be silently downgraded either.
{
	const before = await readState();
	const out = await call("ego_app_pointer", { action: "mouse_click", name, selector: "#target", x: 40, y: 40 });
	const after = await readState();
	check(
		"mouse_click refuses selector+x/y ambiguity",
		out.ok === false && clickCountOf(after) === clickCountOf(before),
		{ ok: out.ok, clicks: clicksOf(after).length, error: String(out.error ?? "").slice(0, 120) }
	);
}

// An unknown action must not fall through to a coordinate click.
{
	const before = await readState();
	const out = await call("ego_app_pointer", { action: "tap", name, selector: "#target" });
	const after = await readState();
	check(
		"unknown pointer action is rejected, not treated as mouse_click",
		out.ok === false && clickCountOf(after) === clickCountOf(before),
		{ ok: out.ok, clicks: clicksOf(after).length, error: String(out.error ?? "").slice(0, 120) }
	);
}

// ── the supported paths still work ──────────────────────────────────────────
{
	const out = await call("ego_app_pointer", { action: "mouse_click", name, selector: "#target" });
	const state = await readState();
	const hits = clicksOf(state).filter((entry) => entry.target === "target");
	check(
		"mouse_click with plain CSS lands on the element",
		out.ok === true && hits.length > 0 && hits.every((entry) => !(entry.x === 0 && entry.y === 0)),
		{ ok: out.ok, hits: hits.length, last: hits[hits.length - 1] ?? null }
	);
}
{
	const out = await call("ego_app_pointer", { action: "mouse_click", name, x: 90, y: 120 });
	const state = await readState();
	const hit = clicksOf(state).find((entry) => entry.x === 90 && entry.y === 120);
	check("mouse_click with x/y clicks those coordinates", out.ok === true && Boolean(hit), { ok: out.ok, hit });
}
{
	const out = await call("ego_app_pointer", { action: "mouse_click", name, selector: "#does-not-exist" });
	check("mouse_click reports a missing selector", out.ok === false, { ok: out.ok, error: String(out.error ?? "").slice(0, 120) });
}
{
	const out = await call("ego_app_pointer", { action: "mouse_click", name, x: 90, y: 160, button: "right" });
	check("mouse_click accepts button", out.ok === true, { ok: out.ok, error: String(out.error ?? "").slice(0, 120) });
}

await call("ego_app_space", { action: "finish", name, keep: false });

const failed = results.filter((row) => !row.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
process.exitCode = failed.length === 0 ? 0 : 1;
