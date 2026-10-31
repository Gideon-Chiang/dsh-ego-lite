/**
 * Integration regression for dsh-ego-lite 0.1.2 against the REAL ego lite app.
 * Loads the plugin's apply() with a minimal fake ctx, then drives the tools.
 */
// Opt-in: needs the ego lite app running, past onboarding. Not part of `npm test`.
//   node test/live-e2e.mjs
import { apply } from "../lib/index.js";

const tools = new Map();
const ctx = {
	tools: { register: (tool) => tools.set(tool.name, tool) },
	systemPrompt: { section: () => {} }
};
apply(ctx, { executable: "auto", timeoutMs: 180000, maxOutputBytes: 1048576, announceToAgent: false });

const call = (name, args = {}) => tools.get(name).execute(args, {});
const results = [];
const check = (label, ok, detail) => {
	results.push({ label, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail ? JSON.stringify(detail).slice(0, 260) : ""}`);
};

const status = await call("ego_app_status");
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
	again.ok === false && /may already be closed or deleted/.test(again.error ?? ""),
	{ ok: again.ok, error: (again.error ?? "").slice(0, 160) }
);

// ── 0.1.3: receipts, downloads, chooser, subtree, rich paste, pointer buttons ──
const fixturePath = process.env.EGO_E2E_FIXTURE ?? "C:/Users/Chiang/Desktop/Temp_Project/Default/ego-tools-test2.html";
const fixture = "file:///" + fixturePath;
const advanced = await call("ego_app_space", { action: "open", name: "e2e-进阶" });
const advId = advanced.spaceId;
const nav = await call("ego_app_navigate", { name: "e2e-进阶", url: fixture });
check("advanced fixture opens", nav.ok === true && /ego-tools-test2/.test(nav.url ?? ""), { ok: nav.ok });

const rightClick = await call("ego_app_pointer", { action: "mouse_click", name: "e2e-进阶", selector: "#ctx", button: "right", x: 0, y: 0 });
const ctxCount = await call("ego_app_js", { name: "e2e-进阶", expression: "document.getElementById('ctxOut').textContent" });
check(
	"pointer button=right reaches the page",
	rightClick.ok === true && Number(ctxCount.value) > 0,
	{ ok: rightClick.ok, contextmenu: ctxCount.value, receipt: rightClick.receipt ?? null }
);

const popupClick = await call("ego_app_click", { name: "e2e-进阶", selector: "#popup" });
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
	saveAs: "C:/Users/Chiang/Desktop/Temp_Project/Default/ego-download-result.txt"
});
const fsHas = await import("node:fs");
const savedOk = downloaded.ok === true && fsHas.existsSync("C:/Users/Chiang/Desktop/Temp_Project/Default/ego-download-result.txt");
check("ego_app_download saves the artifact", savedOk, { ok: downloaded.ok, download: downloaded.download ?? null, saved: downloaded.saved });

const chooser = await call("ego_app_page", {
	action: "file_chooser",
	name: "e2e-进阶",
	trigger: "#pick",
	files: ["C:/Users/Chiang/Desktop/Temp_Project/Default/ego-upload-fixture.txt"]
});
const fileOut = await call("ego_app_js", { name: "e2e-进阶", expression: "document.getElementById('fileOut').textContent" });
check(
	"file_chooser sets files from a click trigger",
	chooser.ok === true && /ego-upload-fixture\.txt/.test(String(fileOut.value ?? "")),
	{ ok: chooser.ok, echoed: fileOut.value, files: chooser.files }
);

await call("ego_app_page", { action: "focus", name: "e2e-进阶", selector: "#editable" });
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

const advFinish = await call("ego_app_space", { action: "finish", name: "e2e-进阶", keep: false });
check("advanced space finishes cleanly", advFinish.ok === true, advFinish);

const failed = results.filter((row) => !row.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
process.exitCode = failed.length === 0 ? 0 : 1;
