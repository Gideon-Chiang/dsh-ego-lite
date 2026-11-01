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

// ── helpers for the 0.1.9 regressions (each live case cleans up after itself) ──
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A failure is readable when it is prose, not a raw engine error leaking out. */
const readable = (value) =>
	typeof value === "string" && value.trim().length > 5 && !/SyntaxError|ReferenceError|TypeError/.test(value);
/**
 * A successful terminal action reports either ego's own receipt string (normal
 * path) or, when ego ended the agent task mid-action and dropped the output,
 * `receipt: null` plus `verifiedBy: "listTaskSpaces"`. Both are real successes;
 * a mixture of the two shapes is not.
 */
const receiptOrListVerified = (out) =>
	typeof out.receipt === "string" && out.receipt.length > 0 && out.verifiedBy === undefined
		? "receipt"
		: out.receipt === null && out.verifiedBy === "listTaskSpaces"
			? "listTaskSpaces"
			: null;
const listSpaces = async () => {
	const out = await call("ego_app_space", { action: "list" });
	return { ok: out.ok === true, spaces: Array.isArray(out.spaces) ? out.spaces : [] };
};
const listedSpace = (spaces, name, id) =>
	spaces.find((space) => (id !== undefined && space.id === id) || (name !== undefined && space.name === name)) ?? null;
/** Best-effort removal so a failed assertion can never leak a TaskSpace into the app. */
const cleanupSpace = async (name, id) => {
	let listed = await listSpaces();
	if (!listed.ok) return false;
	if (!listedSpace(listed.spaces, name, id)) return true;
	// user-owned spaces (e.g. after finish/complete) delete directly; agent-owned
	// ones must be closed or finished first.
	if (typeof id === "number") await call("ego_app_space", { action: "delete", ids: [id] });
	listed = await listSpaces();
	if (!listed.ok) return false;
	if (!listedSpace(listed.spaces, name, id)) return true;
	if (name !== undefined) {
		await call("ego_app_space", { action: "close", name });
		await sleep(300);
		listed = await listSpaces();
		if (!listed.ok) return false;
		if (!listedSpace(listed.spaces, name, id)) return true;
		await call("ego_app_space", { action: "finish", name, keep: false });
		await sleep(300);
		listed = await listSpaces();
		if (!listed.ok) return false;
	}
	return !listedSpace(listed.spaces, name, id);
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
check(
	"finish reports measured ownership and ego's receipt of what was kept/closed",
	finished.ok === true &&
		finished.ownership === "user" &&
		((typeof finished.receipt === "object" &&
			finished.receipt !== null &&
			"closedSpace" in finished.receipt &&
			Array.isArray(finished.receipt.keptManagedLabels) &&
			Array.isArray(finished.receipt.closedManagedLabels) &&
			typeof finished.receipt.preservedUnmanagedCount === "number" &&
			finished.verifiedBy === undefined) ||
			(finished.receipt === null && finished.verifiedBy === "listTaskSpaces")),
	{ ownership: finished.ownership, receipt: finished.receipt ?? null, verifiedBy: finished.verifiedBy ?? null }
);

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
// The blocked chooser above left a dialog open, so its scroll restore could not
// run while the dialog was open and the page stayed scrolled past the top
// section; ego's click does not scroll the element into view itself, so put
// #target back in the viewport (unrelated to the receipt shape under test).
await call("ego_app_js", {
	name: "e2e-进阶",
	expression: "document.getElementById('target').scrollIntoView({ block: 'center' }); 'scrolled'"
});
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

// ── 0.1.9 h: mouse_click accepts css=, rejects ego locators readably (N11) ──
const ctxBefore = Number(
	(await call("ego_app_js", { name: "e2e-进阶", expression: "document.getElementById('ctxOut').textContent" })).value
);
const cssClick = await call("ego_app_pointer", {
	action: "mouse_click", name: "e2e-进阶", selector: "css=#ctx", button: "right", timeoutMs: 8000
});
const ctxAfter = Number(
	(await call("ego_app_js", { name: "e2e-进阶", expression: "document.getElementById('ctxOut').textContent" })).value
);
check(
	"mouse_click accepts a css= locator",
	cssClick.ok === true && ctxAfter > ctxBefore,
	{ ok: cssClick.ok, before: ctxBefore, after: ctxAfter, error: String(cssClick.error ?? "").slice(0, 140) }
);

const clicksBefore = Number(
	(await call("ego_app_js", { name: "e2e-进阶", expression: "document.getElementById('clickCount').textContent" })).value
);
const locatorClick = await call("ego_app_pointer", {
	action: "mouse_click", name: "e2e-进阶", selector: 'button:has-text("click target")'
});
const clicksAfter = Number(
	(await call("ego_app_js", { name: "e2e-进阶", expression: "document.getElementById('clickCount').textContent" })).value
);
check(
	"mouse_click rejects a suffix :has-text() locator readably instead of degrading to querySelector",
	locatorClick.ok === false && /does not accept/.test(String(locatorClick.error ?? "")) && clicksAfter === clicksBefore,
	{ ok: locatorClick.ok, error: String(locatorClick.error ?? "").slice(0, 160), before: clicksBefore, after: clicksAfter }
);

// 0.1.9 S3: mouse_click pre-scrolls a plain CSS selector into view; it must put
// the viewport back afterwards instead of leaving the page parked at the target.
const scrollClicksBefore = Number(
	(await call("ego_app_js", { name: "e2e-进阶", expression: "document.getElementById('clickCount').textContent" })).value
);
await call("ego_app_js", { name: "e2e-进阶", expression: "(window.scrollTo(0, 320), window.scrollY)" });
const scrollRestoreClick = await call("ego_app_pointer", { action: "mouse_click", name: "e2e-进阶", selector: "css=#target" });
const scrollAfterRestore = (await call("ego_app_js", { name: "e2e-进阶", expression: "window.scrollY" })).value;
const scrollClicksAfter = Number(
	(await call("ego_app_js", { name: "e2e-进阶", expression: "document.getElementById('clickCount').textContent" })).value
);
check(
	"mouse_click puts the viewport back after pre-scrolling a plain CSS selector",
	scrollRestoreClick.ok === true &&
		scrollClicksAfter === scrollClicksBefore + 1 &&
		Number(scrollAfterRestore) >= 315 &&
		Number(scrollAfterRestore) <= 325,
	{
		ok: scrollRestoreClick.ok,
		clicks: [scrollClicksBefore, scrollClicksAfter],
		scrollY: Number(scrollAfterRestore),
		error: String(scrollRestoreClick.error ?? "").slice(0, 160)
	}
);

const advFinish = await call("ego_app_space", { action: "finish", name: "e2e-进阶", keep: false });
check("advanced space finishes cleanly", advFinish.ok === true, advFinish);

// ═══════════════════════════════════════════════════════════════════════════
// 0.1.9 regressions. Everything below creates its own TaskSpaces and removes
// them again, pass or fail.
// ═══════════════════════════════════════════════════════════════════════════

// A crashed earlier run must not poison this one: drop stale e2e-* spaces.
{
	const stale = await listSpaces();
	for (const space of stale.spaces.filter((row) => /^e2e-/.test(String(row.name ?? "")))) {
		await cleanupSpace(space.name, space.id);
	}
}

// ── a) close right after a separate `open` call: 0.1.8 reported 6/6 of these as
// "still listed" while the space was already gone. Two independent CLI
// processes per iteration, like a real agent turn. ──
const closeAttempts = [];
for (let attempt = 1; attempt <= 6; attempt += 1) {
	const closeName = `e2e-close-${attempt}`;
	const openOut = await call("ego_app_space", { action: "open", name: closeName });
	const closeId = openOut.spaceId;
	const closed = await call("ego_app_space", { action: "close", name: closeName });
	await sleep(300);
	const listed = await listSpaces();
	const stillListed = listed.ok && listed.spaces.some((space) => space.id === closeId);
	closeAttempts.push(closed);
	// On the ended-task path the space is gone before the sentinel can be printed,
	// so lib has no id to echo; the independent list read still proves the close.
	const idKnown = closed.spaceId === closeId || (closed.spaceId === null && closed.verifiedBy === "listTaskSpaces");
	check(
		`close right after a separate open call stays ok and the space really disappears (${attempt}/6)`,
		openOut.ok === true &&
			typeof closeId === "number" &&
			closed.ok === true &&
			closed.closed === true &&
			idKnown &&
			receiptOrListVerified(closed) !== null &&
			listed.ok &&
			!stillListed,
		{ spaceId: closeId, ok: closed.ok, error: String(closed.error ?? "").slice(0, 120), stillListed }
	);
	if (stillListed) await cleanupSpace(closeName, closeId);
}
const closeReceipt = closeAttempts.find((out) => out && out.ok === true);
check(
	"a successful close carries ego's receipt or the ended-task list verification",
	closeReceipt !== undefined && receiptOrListVerified(closeReceipt) !== null,
	{ receipt: closeReceipt ? closeReceipt.receipt : null, verifiedBy: closeReceipt ? closeReceipt.verifiedBy ?? null : null }
);

// ── b) retrying a successful close must be refused by strict space resolution
// and must never create a new same-named space (0.1.8's taskSpace(name) is
// "reuse or create", so a retry silently built a space and closed it). ──
const retryName = "e2e-retry-close";
const retryOpen = await call("ego_app_space", { action: "open", name: retryName });
const retryId = retryOpen.spaceId;
const retryFirst = await call("ego_app_space", { action: "close", name: retryName });
await sleep(300);
const retryBefore = (await listSpaces()).spaces.filter((space) => space.name === retryName).length;
const retryAgain = await call("ego_app_space", { action: "close", name: retryName });
await sleep(300);
const retryAfter = (await listSpaces()).spaces.filter((space) => space.name === retryName).length;
check(
	"the first close succeeds before the retry probe",
	retryOpen.ok === true && retryFirst.ok === true,
	{ spaceId: retryId, firstClose: retryFirst.ok, error: String(retryFirst.error ?? "").slice(0, 120) }
);
check(
	"repeating close after success is refused, without creating a same-named space",
	retryAgain.ok === false &&
		/is currently open\. This action only operates on an existing space; it never creates one\./.test(
			String(retryAgain.error ?? "")
		) &&
		/ego_app_space\{\s*action:\s*["']list["']\s*\}/.test(String(retryAgain.hint ?? "")) &&
		retryAfter <= retryBefore,
	{
		ok: retryAgain.ok,
		error: String(retryAgain.error ?? "").slice(0, 200),
		hint: String(retryAgain.hint ?? "").slice(0, 120),
		retryBefore,
		retryAfter
	}
);
if (retryAfter > 0) await cleanupSpace(retryName, retryId);

// ── c) complete / mark_error: measured ownership + ego's receipt string ──
for (const [action, name] of [["complete", "e2e-complete"], ["mark_error", "e2e-mark-error"]]) {
	const openOut = await call("ego_app_space", { action: "open", name });
	const spaceId = openOut.spaceId;
	const actionArgs = action === "mark_error" ? { action, name, message: "e2e live regression" } : { action, name };
	const done = await call("ego_app_space", actionArgs);
	check(
		`${action} reports measured ownership and a receipt (or the ended-task list verification)`,
		openOut.ok === true &&
			done.ok === true &&
			done.ownership === "user" &&
			receiptOrListVerified(done) !== null,
		{
			ok: done.ok,
			ownership: done.ownership,
			receipt: done.receipt === undefined ? null : String(done.receipt).slice(0, 80),
			verifiedBy: done.verifiedBy ?? null,
			error: String(done.error ?? "").slice(0, 120)
		}
	);
	await cleanupSpace(name, spaceId);
}

// ── d) release: ego refuses to release an agent-created Page; that must arrive
// as a readable message, not a raw engine error. ──
const releaseName = "e2e-release";
const releaseOpen = await call("ego_app_space", { action: "open", name: releaseName });
const releaseId = releaseOpen.spaceId;
const createdPage = await call("ego_app_space", { action: "open_page", name: releaseName });
let released = null;
try {
	released = await call("ego_app_space", { action: "release", name: releaseName, page: createdPage.page });
} catch (error) {
	released = { thrown: String(error && error.message ? error.message : error) };
}
check(
	"release answers readably instead of leaking a raw engine error",
	createdPage.ok === true &&
		released !== null &&
		(released.ok === true || readable(released.error) || readable(released.thrown)),
	{ ok: released?.ok, page: createdPage.page, error: String(released?.error ?? released?.thrown ?? "").slice(0, 160) }
);
await cleanupSpace(releaseName, releaseId);

// ── e) wait_control honours timeoutMs (fails in ~1.5 s after handoff), reports
// requested/effective/clamped, and takeover restores control. ──
const waitName = "e2e-wait-control";
const waitOpen = await call("ego_app_space", { action: "open", name: waitName });
const waitId = waitOpen.spaceId;
const waitHandoff = await call("ego_app_space", { action: "handoff", name: waitName });
const waitStart = Date.now();
const waitTimeout = await call("ego_app_space", { action: "wait_control", name: waitName, timeoutMs: 1500 });
const waitElapsed = Date.now() - waitStart;
check(
	"wait_control fails after roughly the requested timeoutMs (~1.5 s)",
	waitHandoff.ok === true &&
		waitTimeout.ok === false &&
		readable(waitTimeout.error) &&
		waitElapsed >= 1400 &&
		waitElapsed <= 15000,
	{ ok: waitTimeout.ok, elapsedMs: waitElapsed, error: String(waitTimeout.error ?? "").slice(0, 160) }
);
const waitTakeover = await call("ego_app_space", { action: "takeover", name: waitName });
check(
	"takeover restores control after the wait_control timeout",
	waitTakeover.ok === true && waitTakeover.ownership === "agent",
	{ ok: waitTakeover.ok, ownership: waitTakeover.ownership, error: String(waitTakeover.error ?? "").slice(0, 160) }
);
const waitClamp = await call("ego_app_space", { action: "wait_control", name: waitName, timeoutMs: 600000 });
check(
	"wait_control reports requestedTimeoutMs/timeoutMs and clamps a 600 s request",
	waitClamp.ok === true &&
		waitClamp.requestedTimeoutMs === 600000 &&
		typeof waitClamp.timeoutMs === "number" &&
		waitClamp.timeoutMs < waitClamp.requestedTimeoutMs &&
		waitClamp.clamped === true,
	{
		requestedTimeoutMs: waitClamp.requestedTimeoutMs,
		timeoutMs: waitClamp.timeoutMs,
		clamped: waitClamp.clamped,
		error: String(waitClamp.error ?? "").slice(0, 120)
	}
);
await cleanupSpace(waitName, waitId);

// ── f) delete{id} (singular), delete{scope:'all'} refusal, delete{scope:'task'} target requirement ──
const deleteName = "e2e-delete";
const deleteOpen = await call("ego_app_space", { action: "open", name: deleteName });
const deleteId = deleteOpen.spaceId;
const deleteFinish = await call("ego_app_space", { action: "finish", name: deleteName, keep: true });
const deleteById = await call("ego_app_space", { action: "delete", id: deleteId });
await sleep(300);
const deleteListed = await listSpaces();
const deleteGone = deleteListed.ok && deleteListed.spaces.every((space) => space.id !== deleteId);
check(
	"delete{id} removes a finished space and reports ego's receipt",
	deleteOpen.ok === true &&
		deleteFinish.ok === true &&
		deleteById.ok === true &&
		Array.isArray(deleteById.deletedIds) &&
		deleteById.deletedIds.includes(deleteId) &&
		Array.isArray(deleteById.skippedRunningSpaceIds) &&
		(deleteById.stillListed === undefined ||
			(Array.isArray(deleteById.stillListed) && deleteById.stillListed.length === 0)) &&
		typeof deleteById.receipt === "object" &&
		deleteById.receipt !== null &&
		Array.isArray(deleteById.receipt.deletedSpaceIds) &&
		deleteById.receipt.deletedSpaceIds.includes(deleteId) &&
		Array.isArray(deleteById.receipt.skippedRunningSpaceIds) &&
		deleteGone,
	{
		ok: deleteById.ok,
		deletedIds: deleteById.deletedIds,
		skippedRunningSpaceIds: deleteById.skippedRunningSpaceIds,
		stillListed: deleteById.stillListed,
		receipt: deleteById.receipt ?? null,
		gone: deleteGone,
		error: String(deleteById.error ?? "").slice(0, 160)
	}
);
const deleteAll = await call("ego_app_space", { action: "delete", scope: "all" });
check(
	"delete{scope:'all'} is explicitly refused with a readable error",
	deleteAll.ok === false && /scope/i.test(String(deleteAll.error ?? "")) && readable(deleteAll.error),
	{ ok: deleteAll.ok, error: String(deleteAll.error ?? "").slice(0, 200) }
);
const deleteTaskNoTarget = await call("ego_app_space", { action: "delete", scope: "task" });
check(
	"delete{scope:'task'} without name/id is refused readably",
	deleteTaskNoTarget.ok === false && readable(deleteTaskNoTarget.error),
	{ ok: deleteTaskNoTarget.ok, error: String(deleteTaskNoTarget.error ?? "").slice(0, 200) }
);
if (!deleteGone) await cleanupSpace(deleteName, deleteId);

// ── g) enum guards: select/fill/tabs/wait reject before doing anything ──
const guardName = "e2e-guards";
const guardOpen = await call("ego_app_space", { action: "open", name: guardName });
const guardId = guardOpen.spaceId;
await call("ego_app_navigate", { name: guardName, url: fixture });
await call("ego_app_js", {
	name: guardName,
	expression: "const sel = document.getElementById('choice'); sel.value = 'b'; 'ready'"
});
const selectBefore = (await call("ego_app_js", { name: guardName, expression: "document.getElementById('choice').value" })).value;
const selectOut = await call("ego_app_select", { name: guardName, selector: "#choice" });
const selectAfter = (await call("ego_app_js", { name: guardName, expression: "document.getElementById('choice').value" })).value;
check(
	"select{} without value/label/index is refused with 'requires one of' and changes no selection",
	selectOut.ok === false && /requires one of/.test(String(selectOut.error ?? "")) && selectAfter === selectBefore,
	{ ok: selectOut.ok, error: String(selectOut.error ?? "").slice(0, 160), selectBefore, selectAfter }
);

await call("ego_app_js", {
	name: guardName,
	// ego's element actions refuse an element that is outside the viewport, so
	// scroll it in first — the guards under test must be rejected before this.
	expression:
		"const editor = document.getElementById('editable'); editor.scrollIntoView({ block: 'center' }); editor.textContent = 'keep-me'; 'ready'"
});
const fillOut = await call("ego_app_fill", { name: guardName, selector: "#editable" });
const fillAfter = (await call("ego_app_js", { name: guardName, expression: "document.getElementById('editable').textContent" })).value;
check(
	"fill{} without value is refused with 'value is required' and clears nothing",
	fillOut.ok === false && /value is required/.test(String(fillOut.error ?? "")) && fillAfter === "keep-me",
	{ ok: fillOut.ok, error: String(fillOut.error ?? "").slice(0, 160), text: fillAfter }
);
const clearOut = await call("ego_app_fill", { name: guardName, selector: "#editable", value: "" });
const clearAfter = (await call("ego_app_js", { name: guardName, expression: "document.getElementById('editable').textContent" })).value;
check(
	"fill{} with an explicit empty value still clears the element",
	clearOut.ok === true && clearAfter === "",
	{ ok: clearOut.ok, text: clearAfter, error: String(clearOut.error ?? "").slice(0, 160) }
);

const tabsBefore = await call("ego_app_tabs", { scope: "space", name: guardName });
const tabsOpen = await call("ego_app_tabs", { action: "open", scope: "app" });
const tabsAfter = await call("ego_app_tabs", { scope: "space", name: guardName });
check(
	"tabs{action:'open'} without url is refused with 'url is required' and opens no page",
	tabsOpen.ok === false &&
		/url is required/.test(String(tabsOpen.error ?? "")) &&
		Array.isArray(tabsBefore.tabs) &&
		Array.isArray(tabsAfter.tabs) &&
		tabsAfter.tabs.length === tabsBefore.tabs.length,
	{
		ok: tabsOpen.ok,
		error: String(tabsOpen.error ?? "").slice(0, 160),
		before: tabsBefore.tabs?.length,
		after: tabsAfter.tabs?.length
	}
);

const urlBefore = (await call("ego_app_js", { name: guardName, expression: "location.href" })).value;
const waitUrl = await call("ego_app_wait", { name: guardName, for: "url", timeoutMs: 2000 });
const urlAfter = (await call("ego_app_js", { name: guardName, expression: "location.href" })).value;
check(
	"wait{for:'url'} without url is refused with 'url is required' and does not navigate",
	waitUrl.ok === false && /url is required/.test(String(waitUrl.error ?? "")) && urlAfter === urlBefore,
	{ ok: waitUrl.ok, error: String(waitUrl.error ?? "").slice(0, 160), before: String(urlBefore).slice(0, 80), after: String(urlAfter).slice(0, 80) }
);
// 0.1.9: both ego_app_tabs scopes once died with "ReferenceError: spaceArg is
// not defined" after the strict space-resolution refactor — and the missing-url
// guard above returns before that code path, so it cannot see the breakage.
const pagesBeforeTabOpen = await call("ego_app_space", { action: "pages", name: guardName });
const tabsApp = await call("ego_app_tabs", { scope: "app" });
check(
	"ego_app_tabs{scope:'app'} without name returns an app tab list",
	tabsApp.ok === true && Array.isArray(tabsApp.tabs),
	{ ok: tabsApp.ok, tabs: Array.isArray(tabsApp.tabs) ? tabsApp.tabs.length : null, error: String(tabsApp.error ?? "").slice(0, 140) }
);
const tabsSpace = await call("ego_app_tabs", { scope: "space", name: guardName });
check(
	"ego_app_tabs{scope:'space'} returns the space tab list",
	tabsSpace.ok === true && Array.isArray(tabsSpace.tabs) && tabsSpace.tabs.length >= 1,
	{ ok: tabsSpace.ok, tabs: Array.isArray(tabsSpace.tabs) ? tabsSpace.tabs.length : null, error: String(tabsSpace.error ?? "").slice(0, 140) }
);
const spaceTabsAction = await call("ego_app_space", { action: "tabs", name: guardName });
const spacePagesAction = await call("ego_app_space", { action: "pages", name: guardName });
check(
	"ego_app_space{action:'tabs'} and {action:'pages'} both work on a real space",
	spaceTabsAction.ok === true &&
		Array.isArray(spaceTabsAction.tabs) &&
		spacePagesAction.ok === true &&
		Array.isArray(spacePagesAction.pages) &&
		spacePagesAction.pages.length >= 1,
	{
		tabsOk: spaceTabsAction.ok,
		tabs: Array.isArray(spaceTabsAction.tabs) ? spaceTabsAction.tabs.length : null,
		pagesOk: spacePagesAction.ok,
		pages: spacePagesAction.pages,
		error: String(spaceTabsAction.error ?? spacePagesAction.error ?? "").slice(0, 140)
	}
);
const tabOpen = await call("ego_app_tabs", { scope: "space", action: "open", name: guardName });
const pagesAfterTabOpen = await call("ego_app_space", { action: "pages", name: guardName });
const pagesBeforeLabels = Array.isArray(pagesBeforeTabOpen.pages) ? pagesBeforeTabOpen.pages : [];
const pagesAfterLabels = Array.isArray(pagesAfterTabOpen.pages) ? pagesAfterTabOpen.pages : [];
const newPageLabels = pagesAfterLabels.filter((label) => !pagesBeforeLabels.includes(label));
check(
	"tabs{scope:'space', action:'open'} creates a Page that ego_app_space{pages} lists",
	tabOpen.ok === true &&
		Array.isArray(tabOpen.tabs) &&
		pagesAfterTabOpen.ok === true &&
		pagesAfterLabels.length === pagesBeforeLabels.length + 1 &&
		newPageLabels.length === 1,
	{
		tabOpenOk: tabOpen.ok,
		before: pagesBeforeLabels,
		after: pagesAfterLabels,
		newPage: newPageLabels[0] ?? null,
		error: String(tabOpen.error ?? pagesAfterTabOpen.error ?? "").slice(0, 140)
	}
);

// The createTab branch is the one action-level tabs path that had no coverage;
// it must create a real app tab for the requested URL. It runs after the
// space-open check because ego.createTab() also adds the tab to the space's
// Page list, which would otherwise skew the "one new Page" comparison above.
const tabAppOpen = await call("ego_app_tabs", { scope: "app", action: "open", name: guardName, url: fixture });
check(
	"ego_app_tabs{scope:'app', action:'open'} runs the createTab path",
	tabAppOpen.ok === true &&
		Array.isArray(tabAppOpen.tabs) &&
		tabAppOpen.tabs.some((tab) => /interaction\.html/.test(String(tab.url ?? ""))),
	{
		ok: tabAppOpen.ok,
		tabs: Array.isArray(tabAppOpen.tabs) ? tabAppOpen.tabs.length : null,
		urls: (Array.isArray(tabAppOpen.tabs) ? tabAppOpen.tabs : []).map((tab) => String(tab.url ?? "").slice(0, 70)),
		error: String(tabAppOpen.error ?? "").slice(0, 160)
	}
);
// 0.1.9 S3: an explicit force must not be silently ignored, and a blank name
// must not fall back to "the newest agent space".
const forceDelete = await call("ego_app_space", { action: "delete", ids: [guardId], force: true });
const guardListedAfterForce = (await listSpaces()).spaces.some((space) => space.id === guardId);
check(
	"delete{ids:[agent-owned], force:true} is refused readably and deletes nothing",
	forceDelete.ok === false &&
		/force:true cannot make ego delete/.test(String(forceDelete.error ?? "")) &&
		readable(forceDelete.error) &&
		guardListedAfterForce,
	{ ok: forceDelete.ok, error: String(forceDelete.error ?? "").slice(0, 200), stillListed: guardListedAfterForce }
);
const blankNameClose = await call("ego_app_space", { action: "close", name: "   " });
const guardListedAfterBlank = (await listSpaces()).spaces.some((space) => space.id === guardId);
check(
	"a blank name does not fall back to the newest agent space",
	blankNameClose.ok === false &&
		/name \(string\) or id \(number\) is required for this action/.test(String(blankNameClose.error ?? "")) &&
		typeof blankNameClose.hint === "string" &&
		readable(blankNameClose.error) &&
		guardListedAfterBlank,
	{ ok: blankNameClose.ok, error: String(blankNameClose.error ?? "").slice(0, 180), hint: String(blankNameClose.hint ?? "").slice(0, 120), stillListed: guardListedAfterBlank }
);
await cleanupSpace(guardName, guardId);

// ── i) a 120 KB plain-text ego_app_run exceeds maxOutputBytes (64 KiB here):
// 0.1.9 truncates it and still reports ok:true; 0.1.8 turned it into a failure. ──
const bigTools = new Map();
apply(
	{ tools: { register: (tool) => bigTools.set(tool.name, tool) }, systemPrompt: { section: () => {} } },
	{ executable: "auto", timeoutMs: 180000, maxOutputBytes: 65536, announceToAgent: false }
);
const bigText = "x".repeat(122880); // 120 KiB of ASCII, well past the 64 KiB byte budget
let big = null;
try {
	big = await bigTools.get("ego_app_run").execute({ script: `console.log(${JSON.stringify(bigText)});` }, {});
} catch (error) {
	big = { ok: false, error: `threw: ${String(error && error.message ? error.message : error)}` };
}
check(
	"a 120 KB plain-text ego_app_run is truncated but still ok",
	big.ok === true &&
		big.truncated === true &&
		typeof big.log === "string" &&
		Buffer.byteLength(big.log, "utf8") <= 65536,
	{
		ok: big.ok,
		truncated: big.truncated,
		error: String(big.error ?? "").slice(0, 160),
		logBytes: typeof big.log === "string" ? Buffer.byteLength(big.log, "utf8") : null
	}
);

// ── cleanup: every TaskSpace this suite created must be gone ──
const leftoverSweep = await listSpaces();
for (const space of leftoverSweep.spaces.filter((row) => /^(e2e-|pointer-)/.test(String(row.name ?? "")))) {
	await cleanupSpace(space.name, space.id);
}
const finalList = await listSpaces();
const leftovers = finalList.spaces.filter((row) => /^(e2e-|pointer-)/.test(String(row.name ?? "")));
check(
	"no test TaskSpace is left behind in the app",
	finalList.ok === true && leftovers.length === 0,
	{
		listed: finalList.spaces.map((space) => ({ id: space.id, name: space.name })),
		leftovers: leftovers.map((space) => ({ id: space.id, name: space.name }))
	}
);

const failed = results.filter((row) => !row.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
process.exitCode = failed.length === 0 ? 0 : 1;
