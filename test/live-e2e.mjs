/**
 * Integration regression for dsh-ego-lite (live) against the REAL ego lite app.
 * Loads the plugin's apply() with a minimal fake ctx, then drives the tools.
 */
// Opt-in: needs the ego lite app running, past onboarding. Not part of `npm test`.
//   node test/live-e2e.mjs
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";

const tools = new Map();
const ctx = {
	tools: { register: (tool) => tools.set(tool.name, tool) },
	systemPrompt: { section: () => {} }
};
apply(ctx, { executable: "auto", timeoutMs: 180000, maxOutputBytes: 1048576, announceToAgent: false });

const call = (name, args = {}) => tools.get(name).execute(args, {});
const fixtures = new URL("./fixtures/", import.meta.url);
const uploadFixture = fileURLToPath(new URL("upload-fixture.txt", fixtures)).split("\\").join("/");
const downloadTarget = path.join(tmpdir(), "ego-live-e2e-download.txt").split("\\").join("/");
const results = [];
const check = (label, ok, detail) => {
	results.push({ label, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail ? JSON.stringify(detail).slice(0, 260) : ""}`);
};

const status = await call("ego_app_status");
if (!status.ok || !status.data) {
	console.log("SKIP  ego lite is not running (or has not finished onboarding); start it and rerun: npm run test:live");
	if (process.env.EGO_E2E_REQUIRE) { console.error("FAIL  EGO_E2E_REQUIRE is set but ego lite is not running"); process.exit(1); }
	process.exit(0);
}
check("status returns data (no silent null)", status.ok === true && status.data !== null, { ok: status.ok, spaces: status.data?.spaces?.length });

const opened = await call("ego_app_space", { action: "open", name: "e2e-回归" });
const id = opened.spaceId;
check("space open", opened.ok === true && typeof id === "number" && id > 0, { spaceId: id, ownership: opened.ownership });

const blockedDelete = await call("ego_app_space", { action: "delete", ids: [id] });
check(
	"delete refuses an agent-owned space with a readable message",
	blockedDelete.ok === false && /only removes user-owned/.test(blockedDelete.error ?? "") && !/SyntaxError/.test(blockedDelete.error ?? ""),
	{ ok: blockedDelete.ok, error: (blockedDelete.error ?? "").slice(0, 120) }
);

const handoff = await call("ego_app_space", { action: "handoff", name: "e2e-回归" });
check("handoff", handoff.ok === true && handoff.handedOff === true, handoff);

const paused = await call("ego_app_navigate", { name: "e2e-回归", url: "https://example.com" });
check("browser command paused after handoff (hint present)", paused.ok === false && /wait_control/.test(paused.hint ?? ""), { ok: paused.ok });

const takeover = await call("ego_app_space", { action: "takeover", name: "e2e-回归" });
check(
	"takeover actually returns control (ownership=agent)",
	takeover.ok === true && takeover.tookOver === true && takeover.ownership === "agent",
	takeover
);

const resumed = await call("ego_app_navigate", { name: "e2e-回归", url: "https://example.com" });
check("browser command works after takeover", resumed.ok === true && /example\.com/.test(resumed.url ?? ""), { ok: resumed.ok, url: resumed.url });

const gesture = await call("ego_app_gesture", { action: "highlight", name: "e2e-回归", x: 300, y: 260 });
check("gesture keeps shown boolean and surfaces detail", gesture.ok === true && typeof gesture.shown === "boolean", gesture);

const plain = await call("ego_app_run", { script: "console.log('plain-text-ok');" });
check("ego_app_run plain text still allowed", plain.ok === true && /plain-text-ok/.test(plain.log ?? ""), { ok: plain.ok, log: plain.log });

const awaited = await call("ego_app_run", {
	script: `const t = await taskSpace('e2e-回归');
console.log('@@DSH_RESULT@@' + JSON.stringify({ spaceId: t.spaceId, name: t.name }));`
});
check("ego_app_run with awaited taskSpace", awaited.ok === true && awaited.result?.spaceId === id, { ok: awaited.ok, result: awaited.result });

const finished = await call("ego_app_space", { action: "finish", name: "e2e-回归", keep: true });
check("finish keep=true leaves a user-owned space to delete", finished.ok === true && finished.keep === "all", finished);

const deleted = await call("ego_app_space", { action: "delete", ids: [id] });
check(
	"delete reports deletedIds and confirms removal",
	deleted.ok === true && Array.isArray(deleted.deletedIds) && deleted.deletedIds.includes(id) && Array.isArray(deleted.stillListed) && deleted.stillListed.length === 0,
	deleted
);

const again = await call("ego_app_space", { action: "delete", ids: [id] });
check(
	"delete on a gone id explains itself",
	again.ok === false && /(nothing left to delete|may have been closed or deleted)/.test(again.error ?? ""),
	{ ok: again.ok, error: (again.error ?? "").slice(0, 160) }
);

// ── 0.1.3: receipts, downloads, chooser, subtree, rich paste, pointer buttons ──
const fixturePath = process.env.EGO_E2E_FIXTURE ?? fileURLToPath(new URL("./fixtures/interaction.html", import.meta.url));
const fixture = "file:///" + fixturePath.split("\\").join("/");
const advanced = await call("ego_app_space", { action: "open", name: "e2e-进阶" });
const advId = advanced.spaceId;
const nav = await call("ego_app_navigate", { name: "e2e-进阶", url: fixture });
check("advanced fixture opens", nav.ok === true && /interaction\.html/.test(nav.url ?? ""), { ok: nav.ok });

const rightClick = await call("ego_app_pointer", { action: "mouse_click", name: "e2e-进阶", selector: "#ctx", button: "right", timeoutMs: 8000 });
const ctxCount = await call("ego_app_js", { name: "e2e-进阶", expression: "document.getElementById('ctxOut').textContent" });
check(
	"pointer button=right reaches the page",
	rightClick.ok === true && Number(ctxCount.value) > 0,
	{ ok: rightClick.ok, contextmenu: ctxCount.value, receipt: rightClick.receipt ?? null }
);

const popupClick = await call("ego_app_click", { name: "e2e-进阶", selector: "#pop" });
check(
	"click receipt reports the popup",
	popupClick.ok === true && Array.isArray(popupClick.receipt?.popups) && popupClick.receipt.popups.length > 0,
	{ ok: popupClick.ok, receipt: popupClick.receipt ?? null }
);

const alertClick = await call("ego_app_click", { name: "e2e-进阶", selector: "#alertBtn" });
check(
	"click receipt reports the dialog",
	alertClick.ok === true && alertClick.receipt?.dialog?.type === "alert" && /receipt dialog/.test(String(alertClick.receipt?.dialog?.message ?? "")),
	{ ok: alertClick.ok, receipt: alertClick.receipt ?? null }
);
// An open dialog blocks every later round on that page: answer it before continuing.
const dismissed = await call("ego_app_dialog", { action: "accept", name: "e2e-进阶" });
check("the reported dialog is answerable with ego_app_dialog", dismissed.ok === true && dismissed.handled === true, dismissed);

const downloaded = await call("ego_app_download", {
	name: "e2e-进阶",
	trigger: "#dl",
	saveAs: downloadTarget
});
const fsHas = await import("node:fs");
const savedOk = downloaded.ok === true && fsHas.existsSync(downloadTarget);
check("ego_app_download saves the artifact", savedOk, { ok: downloaded.ok, download: downloaded.download ?? null, saved: downloaded.saved });

const chooser = await call("ego_app_page", {
	action: "file_chooser",
	name: "e2e-进阶",
	trigger: "#pick",
	timeoutMs: 8000,
	files: [uploadFixture]
});
const fileOut = await call("ego_app_js", { name: "e2e-进阶", expression: "document.getElementById('fileOut').textContent" });
check(
	"file_chooser sets files from a click trigger",
	chooser.ok === true && /upload-fixture\.txt/.test(String(fileOut.value ?? "")),
	{ ok: chooser.ok, echoed: fileOut.value, files: chooser.files }
);
check(
	"file_chooser reports a real isMultiple() boolean",
	chooser.ok === true && chooser.multiple === false,
	{ multiple: chooser.multiple }
);
// Shape guard only: this fixture never raises an upload-triggered dialog, so the
// assertion can only catch a regression back to { dialog: { dialog: ... } }.
check(
	"file_chooser dialog field is never double-wrapped (shape guard)",
	chooser.ok === true && (chooser.dialog === null || chooser.dialog?.dialog === undefined),
	{ dialog: chooser.dialog }
);

// A chooser that never opens must still name the click's dialog, and answering
// that dialog must restore the page.
const blockedChooser = await call("ego_app_page", {
	action: "file_chooser", name: "e2e-进阶", trigger: "#alertBtn", timeoutMs: 2500, files: [uploadFixture]
});
check(
	"file_chooser timeout carries the click receipt",
	blockedChooser.ok === false && /click receipt/.test(String(blockedChooser.error ?? "")) && /"alert"/.test(String(blockedChooser.error ?? "")),
	{ ok: blockedChooser.ok, error: String(blockedChooser.error ?? "").slice(0, 160) }
);
check(
	"file_chooser timeout hint points at the blocking dialog",
	/ego_app_dialog/.test(String(blockedChooser.error ?? "")),
	{ matched: /ego_app_dialog/.test(String(blockedChooser.error ?? "")) }
);
const answered = await call("ego_app_dialog", { action: "accept", name: "e2e-进阶" });
const afterTimeout = await call("ego_app_page", {
	action: "file_chooser", name: "e2e-进阶", trigger: "#pick", timeoutMs: 8000, files: [uploadFixture]
});
check(
	"chooser works again after answering the reported dialog",
	answered.ok === true && answered.handled === true && afterTimeout.ok === true && afterTimeout.multiple === false,
	{ answered: answered.ok, ok: afterTimeout.ok }
);

// receipt must be absent (API returned nothing) or an object, never null
const receipted = await call("ego_app_click", { name: "e2e-进阶", selector: "#target" });
check(
	"an action receipt is an object when present, never null",
	receipted.ok === true && (receipted.receipt === undefined || (typeof receipted.receipt === "object" && receipted.receipt !== null)),
	{ ok: receipted.ok, receipt: receipted.receipt }
);

await call("ego_app_page", { action: "focus", name: "e2e-进阶", selector: "#editable", timeoutMs: 8000 });
const pasted = await call("ego_app_key", {
	action: "paste",
	name: "e2e-进阶",
	text: "Name	Status",
	html: "<table><tr><td>Name</td><td>Status</td></tr></table>"
});
const richHtml = await call("ego_app_js", { name: "e2e-进阶", expression: "document.getElementById('editable').innerHTML" });
check(
	"keyboard paste keeps the HTML flavour",
	pasted.ok === true && /<table/i.test(String(richHtml.value ?? "")),
	{ ok: pasted.ok, html: String(richHtml.value ?? "").slice(0, 80) }
);

const view = await call("ego_app_snapshot", { name: "e2e-进阶", scope: "viewport" });
const iframeRef = /iframe \[ref=(\d+)/.exec(String(view.snapshot ?? ""));
const subtree = iframeRef
	? await call("ego_app_snapshot", { name: "e2e-进阶", scope: "subtree", root: `@${iframeRef[1]}` })
	: { ok: false, error: "no iframe ref in viewport snapshot" };
check(
	"snapshot subtree reaches inside the iframe",
	subtree.ok === true && /inside frame/.test(String(subtree.snapshot ?? "")),
	{ ok: subtree.ok, ref: iframeRef ? `@${iframeRef[1]}` : null, error: subtree.error ? String(subtree.error).slice(0, 120) : undefined }
);

// A waiter that expires before the click resolves must still explain itself.
const expiring = await call("ego_app_page", {
	action: "file_chooser", name: "e2e-进阶", trigger: "#target", timeoutMs: 1, files: [uploadFixture]
});
// trigger opens no chooser on purpose: this exercises the arm-time .catch path,
// not the "click cancelled the chooser" path.
check(
	"an expired waiter still reports the timeout with a click receipt",
	expiring.ok === false && /waitForFileChooser timed out/.test(String(expiring.error ?? "")) && /click receipt/.test(String(expiring.error ?? "")),
	{ ok: expiring.ok, error: String(expiring.error ?? "").slice(0, 150) }
);
await call("ego_app_dialog", { action: "accept", name: "e2e-进阶" }).catch(() => {});

// The trigger click pre-scrolls; the page must be put back where it was so a
// later click on a top-of-page element still works.
await call("ego_app_navigate", { name: "e2e-进阶", url: fixture });
await call("ego_app_js", { name: "e2e-进阶", expression: "window.scrollTo(0, 380); window.scrollY" });
const scrollBefore = Number((await call("ego_app_js", { name: "e2e-进阶", expression: "window.scrollY" })).value);
const scrolledChooser = await call("ego_app_page", {
	action: "file_chooser", name: "e2e-进阶", trigger: "#pick", timeoutMs: 8000, files: [uploadFixture]
});
const scrollAfter = Number((await call("ego_app_js", { name: "e2e-进阶", expression: "window.scrollY" })).value);
check(
	"a trigger click restores the previous scroll offset",
	scrolledChooser.ok === true && Math.abs(scrollAfter - scrollBefore) < 5,
	{ before: scrollBefore, after: scrollAfter }
);
const topAfterScroll = await call("ego_app_click", { name: "e2e-进阶", selector: "#pop" });
check(
	"a top-of-page element still clicks after a trigger click scrolled",
	topAfterScroll.ok === true,
	{ ok: topAfterScroll.ok, error: String(topAfterScroll.error ?? "").slice(0, 120) }
);
await call("ego_app_dialog", { action: "accept", name: "e2e-进阶" }).catch(() => {});

// A scrollIntoView inside an overflow:auto panel must be restored too.
await call("ego_app_navigate", { name: "e2e-进阶", url: fixture });
await call("ego_app_js", { name: "e2e-进阶", expression: "document.getElementById('panel').scrollTop = 0; 'reset'" });
const panelChooser = await call("ego_app_page", {
	action: "file_chooser", name: "e2e-进阶", trigger: "#panelPick", timeoutMs: 8000, files: [uploadFixture]
});
const panelScroll = Number((await call("ego_app_js", { name: "e2e-进阶", expression: "document.getElementById('panel').scrollTop" })).value);
check(
	"a nested scroll container is restored after the trigger click",
	panelChooser.ok === true && Math.abs(panelScroll) < 5,
	{ ok: panelChooser.ok, panelScroll }
);

// Empty saveAs must not fall through to a bare ego TypeError.
let emptySave = null;
try {
	emptySave = await call("ego_app_download", { name: "e2e-进阶", trigger: "#dl", saveAs: "   " });
} catch (error) {
	emptySave = { thrown: String(error && error.message).slice(0, 120) };
}
check(
	"an empty saveAs is rejected with a readable message",
	emptySave && emptySave.ok === false && /non-empty absolute path/.test(String(emptySave.error ?? "")),
	{ result: emptySave }
);

// Typos in `action`/`scope`/`for` must be rejected, never "performed".
const typoTargets = [
	["ego_app_key", { name: "e2e-进阶", action: "typ", text: "x" }],
	["ego_app_cdp", { name: "e2e-进阶", scope: "tasks", method: "Runtime.evaluate" }],
	["ego_app_wait", { name: "e2e-进阶", for: "nope" }],
	["ego_app_gesture", { name: "e2e-进阶", action: "wave" }]
];
const typoResults = [];
for (const [tool, args] of typoTargets) {
	const out = await call(tool, args);
	typoResults.push({ tool, rejected: out.ok === false && /unknown /.test(String(out.error ?? "")) });
}
check(
	"unknown action/scope/for values are rejected instead of acting",
	typoResults.every((row) => row.rejected),
	typoResults
);

const waitOwnership = await call("ego_app_space", { action: "wait_control", name: "e2e-进阶" });
check(
	"wait_control reports the ownership it actually observed",
	waitOwnership.ok === true && waitOwnership.control === true && waitOwnership.ownership === "agent",
	{ ok: waitOwnership.ok, ownership: waitOwnership.ownership }
);

const advFinish = await call("ego_app_space", { action: "finish", name: "e2e-进阶", keep: false });
check("advanced space finishes cleanly", advFinish.ok === true, advFinish);

const failed = results.filter((row) => !row.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
process.exitCode = failed.length === 0 ? 0 : 1;
