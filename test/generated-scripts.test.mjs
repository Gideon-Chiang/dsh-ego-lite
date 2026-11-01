/**
 * Generated-script tests against a FAKE ego CLI (no ego lite app needed).
 *
 * The plugin writes a script, spawns `<executable> nodejs -e "await import(…)"`
 * and parses the sentinel result. By pointing `executable` at process.execPath
 * and chdir()-ing into test/fake-cli, node runs the fake CLI there, which stubs
 * the ego runtime and imports the REAL generated script. That lets unit tests
 * assert on host-generated JavaScript (0.1.11: fail-closed reads, function-source
 * detection, terminal-value capture, tabs fail-closed, create validation,
 * dialog waitMs sanitisation) instead of only on the pure helpers.
 *
 * Each test file runs in its own node:test process, so the chdir() is isolated;
 * it is still restored in an `after` hook.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";

const fakeCliDir = fileURLToPath(new URL("./fake-cli/", import.meta.url));
const originalCwd = process.cwd();
const workDir = mkdtempSync(path.join(tmpdir(), "ego-fake-cli-"));
let scratchIndex = 0;

before(() => {
	process.chdir(fakeCliDir);
});
after(() => {
	process.chdir(originalCwd);
});

const scratchPath = (name) => {
	scratchIndex += 1;
	return path.join(workDir, `${scratchIndex}-${name}`);
};

/** Run one tool through a plugin instance that spawns the fake CLI. */
const run = async (toolName, args, { env = {}, exec = {} } = {}) => {
	const tools = new Map();
	apply(
		{ tools: { register: (tool) => tools.set(tool.name, tool) }, systemPrompt: { section: () => {} } },
		{ executable: process.execPath, timeoutMs: 30000, maxOutputBytes: 1048576, announceToAgent: false }
	);
	const previous = {};
	for (const [key, value] of Object.entries(env)) {
		previous[key] = process.env[key];
		process.env[key] = value;
	}
	try {
		return await tools.get(toolName).execute(args, exec);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
};

/** The last generated script the fake CLI saw. */
const lastScript = (dumpPath) => {
	const lines = readFileSync(dumpPath, "utf8").trim().split(/\r?\n/);
	return JSON.parse(lines[lines.length - 1]).script;
};

test("the fake CLI harness runs a real generated script", async () => {
	const dump = scratchPath("harness.dump");
	const out = await run("ego_app_navigate", { name: "fake-space", url: "about:blank", timeoutMs: 5000 }, { env: { EGO_FAKE_DUMP: dump } });
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(out.pageCreated, false);
	assert.equal(existsSync(dump), true, "the fake CLI should have been spawned");
	assert.match(lastScript(dump), /page\.goto\(/);
});

// ── B: an unreadable space list must fail closed, not be read as "no space" ──
test("an unreadable space list makes a space action fail closed with 'unreadable'", async () => {
	const out = await run("ego_app_space", { action: "pages", name: "fake-space" }, { env: { EGO_FAKE_LIST: "error" } });
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /unreadable/);
	assert.equal(typeof out.hint, "string");
});

test("an unreadable space list whose detail cannot be serialised still reports 'unreadable'", async () => {
	// 0.1.10 built the error detail with a bare JSON.stringify(); a circular
	// answer threw from inside the error path and hid the real diagnosis.
	const out = await run("ego_app_space", { action: "pages", name: "fake-space" }, { env: { EGO_FAKE_LIST: "circular" } });
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /unreadable/);
});

// ── C: function-source detection for ego_app_js and ego_app_wait ──
test("ego_app_js auto mode evaluates a function-source expression", async () => {
	const out = await run("ego_app_js", { name: "fake-space", expression: "() => 1+1" });
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(out.value, 2, "a whole function source must be evaluated, not wrapped (wrapping yields a function and JSON drops it)");
});

test("ego_app_js explicit statements mode is never auto-switched to function mode", async () => {
	const out = await run("ego_app_js", { name: "fake-space", mode: "statements", expression: "() => 1+1" });
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal("value" in out, false, "statements mode runs the source as a body and returns undefined");
});

test("ego_app_js never auto-detects a function source over an explicit unknown mode", async () => {
	const out = await run("ego_app_js", { name: "fake-space", mode: "statement", expression: "() => 1+1" });
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /unknown js mode "statement"/);
});

test("ego_app_js accepts an explicit fn with an arg", async () => {
	const out = await run("ego_app_js", { name: "fake-space", fn: "(arg) => arg.n + 1", arg: { n: 1 } });
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(out.value, 2);
});

test("wait{for:'function'} uses a false-returning function source as the predicate", async () => {
	const out = await run("ego_app_wait", { name: "fake-space", for: "function", expression: "() => false", timeoutMs: 800 });
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /waitForFunction timed out/);
});

test("wait{for:'function'} still accepts a plain predicate expression", async () => {
	const out = await run("ego_app_wait", { name: "fake-space", for: "function", expression: "1 === 1", timeoutMs: 800 });
	assert.equal(out.ok, true, JSON.stringify(out));
});

// ── D: final-state actions must read their value before the transition ──
test("page{action:'close'} still reports the label after closing", async () => {
	const out = await run("ego_app_page", { action: "close", name: "fake-space" }, { env: { EGO_FAKE_BREAK: "label" } });
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(out.page, "p1", "the label must be captured before page.close() invalidates it");
});

test("space close still reports the spaceId when the ended space drops the field", async () => {
	const out = await run("ego_app_space", { action: "close", name: "fake-space" }, { env: { EGO_FAKE_BREAK: "spaceid" } });
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(out.spaceId, 9001, "the space id must be captured before closeTaskSpace() ends the task");
	assert.equal(out.closed, true);
	assert.equal(out.ownership, "closed");
});

// ── E: tabs reads are fail-closed in both scopes ──
test("tabs scope=app fails closed when the app tab list is unreadable", async () => {
	const out = await run("ego_app_tabs", { scope: "app", name: "fake-space" }, { env: { EGO_FAKE_TABS: "error" } });
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /the app tab list is unreadable/);
});

test("tabs scope=space fails closed when the TaskSpace tab list is unreadable", async () => {
	const out = await run("ego_app_tabs", { scope: "space", name: "fake-space" }, { env: { EGO_FAKE_SPACE_TABS: "error" } });
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /the TaskSpace tab list is unreadable/);
});

// ── F: create without an id must fail readably and never select a space ──
test("space create without an id fails readably and never calls useTaskSpace", async () => {
	const calls = scratchPath("create.calls");
	const out = await run(
		"ego_app_space",
		{ action: "create", name: "fake-create" },
		{ env: { EGO_FAKE_CREATE: "no-id", EGO_FAKE_CALLS: calls } }
	);
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /did not return a space id/);
	assert.equal(existsSync(calls), false, "useTaskSpace() must not be called with an undefined id");
});

// ── G: dialog waitMs hygiene reaches the generated script ──
test("dialog waitMs:-5 is sanitised to waitForTimeout(0)", async () => {
	const dump = scratchPath("dialog.dump");
	const out = await run(
		"ego_app_dialog",
		{ action: "accept", name: "fake-space", trigger: "#editable", waitMs: -5 },
		{ env: { EGO_FAKE_DUMP: dump } }
	);
	assert.equal(out.ok, true, JSON.stringify(out));
	const script = lastScript(dump);
	assert.doesNotMatch(script, /waitForTimeout\(-5\)/);
	assert.match(script, /waitForTimeout\(0\)/);
});

// ── 0.1.10 behaviour that 0.1.11 must keep ──
test("page tools report pageCreated; space open must not", async () => {
	const pageResult = await run("ego_app_js", { name: "fake-space", expression: "1+1" });
	assert.equal(pageResult.ok, true, JSON.stringify(pageResult));
	assert.equal(pageResult.pageCreated, false);
	assert.equal(pageResult.value, 2);

	const opened = await run("ego_app_space", { action: "open", name: "fake-open" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal("pageCreated" in opened, false, "pageCreated belongs to Page tools, not to space actions");
});

test("a non-positive timeoutMs is rejected before the CLI is spawned", async () => {
	const dump = scratchPath("timeout.dump");
	const out = await run("ego_app_navigate", { name: "fake-space", url: "about:blank", timeoutMs: 0 }, { env: { EGO_FAKE_DUMP: dump } });
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /timeoutMs must be a positive number/);
	assert.equal(existsSync(dump), false, "no CLI process may be spawned");
});

test("an already-aborted signal is rejected before the CLI is spawned", async () => {
	const dump = scratchPath("abort.dump");
	const controller = new AbortController();
	controller.abort();
	const out = await run(
		"ego_app_wait",
		{ name: "fake-space", for: "timeout", timeoutMs: 30000 },
		{ env: { EGO_FAKE_DUMP: dump }, exec: { signal: controller.signal } }
	);
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /aborted by the caller/);
	assert.equal(existsSync(dump), false, "no CLI process may be spawned");
});

// ═══════════════════════════════════════════════════════════════════════════
// Second batch (contract H–U): diagnostics, tabs payloads, adopt evidence,
// dialog/fetch/gesture receipts, hint selection, parse-before-spawn.
// ═══════════════════════════════════════════════════════════════════════════

// ── H: status reports each sub-read (and its failure) separately ──
test("H: status reports version/profiles/tabs and their errors separately", async () => {
	// Healthy, but the first listTabs() fails like a fresh CLI process: the retry
	// must select the newest agent space and report which one it selected.
	const healthy = await run("ego_app_status", {}, { env: { EGO_FAKE_TABS: "unselected" } });
	assert.equal(healthy.ok, true, JSON.stringify(healthy));
	const data = healthy.data;
	assert.equal(data.versionError, null);
	assert.equal(data.version.currentVersion, "fake");
	assert.equal(data.profilesError, null);
	assert.ok(Array.isArray(data.profiles), "profiles must stay an array");
	assert.equal(data.tabsError, null);
	assert.ok(Array.isArray(data.tabs) && data.tabs.length >= 1, JSON.stringify(data.tabs));
	assert.equal(data.tabsSpaceId, 9001);

	// A {error} answer from listProfiles is a diagnostics error, not profile data.
	const profilesFailed = await run("ego_app_status", {}, { env: { EGO_FAKE_TABS: "unselected", EGO_FAKE_PROFILES: "error" } });
	assert.equal(profilesFailed.ok, true, JSON.stringify(profilesFailed));
	assert.ok(Array.isArray(profilesFailed.data.profiles));
	assert.match(String(profilesFailed.data.profilesError ?? ""), /injected profiles failure/);

	// Same for getBrowserVersion().
	const versionFailed = await run("ego_app_status", {}, { env: { EGO_FAKE_TABS: "unselected", EGO_FAKE_VERSION: "error" } });
	assert.equal(versionFailed.ok, true, JSON.stringify(versionFailed));
	assert.equal(versionFailed.data.version, null);
	assert.match(String(versionFailed.data.versionError ?? ""), /injected version failure/);
});

// ── I: tabs payloads / created / opened ──
test("I: tabs payloads carry targetId/openedBy, opened and created", async () => {
	const listed = await run("ego_app_tabs", { scope: "space", name: "fake-space" });
	assert.equal(listed.ok, true, JSON.stringify(listed));
	assert.equal(listed.tabs[0].targetId, 1);
	assert.equal(listed.tabs[0].openedBy, "agent");

	const opened = await run("ego_app_tabs", { scope: "space", action: "open", name: "fake-space" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal(opened.opened, "p2", "the new Page label must be reported as opened");

	const appOpened = await run("ego_app_tabs", { scope: "app", action: "open", name: "fake-space", url: "about:blank" });
	assert.equal(appOpened.ok, true, JSON.stringify(appOpened));
	assert.equal(typeof appOpened.created, "string");
	assert.match(appOpened.created, /fake-tab/);

	const createFailed = await run(
		"ego_app_tabs",
		{ scope: "app", action: "open", name: "fake-space", url: "about:blank" },
		{ env: { EGO_FAKE_CREATETAB: "error" } }
	);
	assert.equal(createFailed.ok, false, JSON.stringify(createFailed));
	assert.match(String(createFailed.error ?? ""), /createTab\(\) returned an error/);
});

// ── J: open_page needs a real Page back ──
test("J: open_page fails when newPage() does not return a Page", async () => {
	const out = await run("ego_app_space", { action: "open_page", name: "fake-space" }, { env: { EGO_FAKE_NEWPAGE: "no-label" } });
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /newPage\(\) did not return a Page/);
});

// ── K: pages/tabs/adopt read guards ──
test("K: space pages/tabs/adopt fail closed when a read is not an array", async () => {
	const pagesFailed = await run("ego_app_space", { action: "pages", name: "fake-space" }, { env: { EGO_FAKE_PAGES: "error" } });
	assert.equal(pagesFailed.ok, false, JSON.stringify(pagesFailed));
	assert.match(String(pagesFailed.error ?? ""), /TaskSpace page list is unreadable/);

	const tabsFailed = await run("ego_app_space", { action: "tabs", name: "fake-space" }, { env: { EGO_FAKE_SPACE_TABS: "error" } });
	assert.equal(tabsFailed.ok, false, JSON.stringify(tabsFailed));
	assert.match(String(tabsFailed.error ?? ""), /TaskSpace tab list is unreadable/);

	const adoptFailed = await run("ego_app_space", { action: "adopt", name: "fake-space" }, { env: { EGO_FAKE_SPACE_TABS: "error" } });
	assert.equal(adoptFailed.ok, false, JSON.stringify(adoptFailed));
	assert.match(String(adoptFailed.error ?? ""), /TaskSpace tab list is unreadable, so adopt cannot resolve a tab/);
});

// ── L: adopt evidence ──
test("L: adopt reports verified, and fails when no Page comes back", async () => {
	const managed = await run("ego_app_space", { action: "adopt", name: "fake-space" });
	assert.equal(managed.ok, true, JSON.stringify(managed));
	assert.equal(managed.page, "p1");
	assert.equal(managed.verified, true);

	const unmanaged = await run("ego_app_space", { action: "adopt", name: "fake-space" }, { env: { EGO_FAKE_ADOPT: "not-managed" } });
	assert.equal(unmanaged.ok, true, JSON.stringify(unmanaged));
	assert.equal(unmanaged.verified, false, "a Page that is not in task.pages() is not verified");

	const noPage = await run("ego_app_space", { action: "adopt", name: "fake-space" }, { env: { EGO_FAKE_ADOPT: "no-page" } });
	assert.equal(noPage.ok, false, JSON.stringify(noPage));
	assert.match(String(noPage.error ?? ""), /adopt\(\) did not return a Page/);
});

// ── M: user_page works with an async userPage() ──
test("M: user_page awaits a possibly-async userPage()", async () => {
	const out = await run("ego_app_space", { action: "user_page", name: "fake-space" });
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(out.userPage.label, "p1");
});

// ── N: dialog answer semantics ──
test("N: dialog sends an empty promptText, captures the click receipt, notes handled:false, and survives a bad waitMs", async () => {
	// promptText:"" is a real answer and must reach acceptDialog("").
	const promptDump = scratchPath("dialog-empty.dump");
	const emptyPrompt = await run(
		"ego_app_dialog",
		{ action: "accept", name: "fake-space", promptText: "", trigger: "#editable", waitMs: 10 },
		{ env: { EGO_FAKE_DUMP: promptDump } }
	);
	assert.equal(emptyPrompt.ok, true, JSON.stringify(emptyPrompt));
	assert.match(lastScript(promptDump), /acceptDialog\(""\)/);

	// The trigger click's receipt is reported back with the answer.
	const withReceipt = await run(
		"ego_app_dialog",
		{ action: "accept", name: "fake-space", trigger: "#editable" },
		{ env: { EGO_FAKE_RECEIPT: "dialog" } }
	);
	assert.equal(withReceipt.ok, true, JSON.stringify(withReceipt));
	assert.equal(withReceipt.receipt?.dialog?.message, "fake dialog");

	// Nothing to answer: handled:false comes with a note.
	const nothingOpen = await run("ego_app_dialog", { action: "accept", name: "fake-space" }, { env: { EGO_FAKE_DIALOG: "none" } });
	assert.equal(nothingOpen.ok, true, JSON.stringify(nothingOpen));
	assert.equal(nothingOpen.handled, false);
	assert.match(String(nothingOpen.note ?? ""), /no dialog was open/);

	// A throwing settle delay must not skip answering the dialog.
	const thrownWait = await run(
		"ego_app_dialog",
		{ action: "accept", name: "fake-space", trigger: "#editable" },
		{ env: { EGO_FAKE_BREAK: "waittimeout" } }
	);
	assert.equal(thrownWait.ok, true, JSON.stringify(thrownWait));
	assert.equal(thrownWait.handled, true);

	// A huge waitMs is capped at 30000.
	const capDump = scratchPath("dialog-cap.dump");
	await run(
		"ego_app_dialog",
		{ action: "accept", name: "fake-space", trigger: "#editable", waitMs: 999999 },
		{ env: { EGO_FAKE_DUMP: capDump } }
	);
	assert.match(lastScript(capDump), /waitForTimeout\(30000\)/);
});

// ── O: fetch echoes options.saveAs ──
test("O: page fetch echoes options.saveAs", async () => {
	const out = await run("ego_app_page", {
		action: "fetch", name: "fake-space", url: "https://example.test/x", options: { saveAs: "C:/tmp/fetch.bin" }
	});
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(out.saveAs, "C:/tmp/fetch.bin");
	assert.equal(out.response.status, 200);
});

// ── P: gesture shown/detail ──
test("P: gesture reports shown:null when the API returns nothing and caps detail", async () => {
	const nothing = await run(
		"ego_app_gesture",
		{ action: "gesture", name: "fake-space", command: { type: "think" } },
		{ env: { EGO_FAKE_GESTURE: "none" } }
	);
	assert.equal(nothing.ok, true, JSON.stringify(nothing));
	assert.equal(nothing.shown, null);
	assert.equal(nothing.detail, null);

	const long = await run("ego_app_gesture", { action: "gesture", name: "fake-space" }, { env: { EGO_FAKE_GESTURE: "long" } });
	assert.equal(long.ok, true, JSON.stringify(long));
	assert.equal(long.shown, true);
	assert.equal(typeof long.detail, "string");
	assert.equal(long.detail.length, 500);
});

// ── Q: page-controlled dialog text is capped in a receipt ──
test("Q: a page-controlled dialog message is capped in the receipt", async () => {
	const out = await run("ego_app_click", { name: "fake-space", selector: "#target" }, { env: { EGO_FAKE_RECEIPT: "long" } });
	assert.equal(out.ok, true, JSON.stringify(out));
	const message = String(out.receipt?.dialog?.message ?? "");
	assert.ok(message.startsWith("x".repeat(2000)), "message must be cut to 2000 characters");
	assert.match(message, /…\[truncated 1000 chars\]/);
	assert.ok(message.length < 2200, `message length ${message.length}`);
});

// ── S: hint selection ──
test("S: hints distinguish tab reads, adopt/release, and the Page budget", async () => {
	const tabsHint = await run("ego_app_tabs", { scope: "app", name: "fake-space" }, { env: { EGO_FAKE_TABS: "error" } });
	assert.equal(tabsHint.ok, false, JSON.stringify(tabsHint));
	assert.match(String(tabsHint.hint ?? ""), /would not list its tabs/);
	assert.doesNotMatch(String(tabsHint.hint ?? ""), /instead of its TaskSpace list/, "the generic TaskSpace-list hint must not win");

	const releaseHint = await run(
		"ego_app_space",
		{ action: "release", name: "fake-space", page: "p1" },
		{ env: { EGO_FAKE_BREAK: "release-agent" } }
	);
	assert.equal(releaseHint.ok, false, JSON.stringify(releaseHint));
	assert.match(String(releaseHint.hint ?? ""), /Only a tab the agent does not manage can be adopted\/released/);

	const budgetHint = await run("ego_app_space", { action: "open_page", name: "fake-space" }, { env: { EGO_FAKE_NEWPAGE: "budget" } });
	assert.equal(budgetHint.ok, false, JSON.stringify(budgetHint));
	assert.match(String(budgetHint.hint ?? ""), /ego allows only 8 Pages per TaskSpace/);
});

// ── T: source parsing happens before spawning a CLI process ──
test("T: invalid function/JavaScript sources are rejected before spawning", async () => {
	const waitDump = scratchPath("wait-syntax.dump");
	const waitOut = await run(
		"ego_app_wait",
		{ name: "fake-space", for: "function", expression: "(() =>" },
		{ env: { EGO_FAKE_DUMP: waitDump } }
	);
	assert.equal(waitOut.ok, false, JSON.stringify(waitOut));
	assert.match(String(waitOut.error ?? ""), /needs a valid function source or expression/);
	assert.equal(existsSync(waitDump), false, "no CLI process may be spawned");

	const jsDump = scratchPath("js-syntax.dump");
	const jsOut = await run("ego_app_js", { name: "fake-space", expression: "const =" }, { env: { EGO_FAKE_DUMP: jsDump } });
	assert.equal(jsOut.ok, false, JSON.stringify(jsOut));
	assert.match(String(jsOut.error ?? ""), /source is not valid JavaScript/);
	assert.equal(existsSync(jsDump), false, "no CLI process may be spawned");
});

// ── U: tabs space branch uses spaceArg (blank name = newest agent space) ──
test("U: tabs space scope treats a blank name as absent", async () => {
	const out = await run("ego_app_tabs", { scope: "space", name: "   " });
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.ok(Array.isArray(out.tabs) && out.tabs.length >= 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Third batch: audit regressions N-a / N-c / N-f / N-g
// ═══════════════════════════════════════════════════════════════════════════

// ── N-a: trailing semicolons are normalised; a broken source never spawns ──
test("N-a: trailing semicolons are normalised and a broken source is rejected before spawning", async () => {
	const fnSemicolon = await run("ego_app_js", { name: "fake-space", expression: "() => 1;" });
	assert.equal(fnSemicolon.ok, true, JSON.stringify(fnSemicolon));
	assert.equal(fnSemicolon.value, 1, "a trailing `;` must not stop the function source from evaluating");

	const exprSemicolon = await run("ego_app_js", { name: "fake-space", expression: "1+1;" });
	assert.equal(exprSemicolon.ok, true, JSON.stringify(exprSemicolon));

	const waitSemicolon = await run(
		"ego_app_wait",
		{ name: "fake-space", for: "function", expression: "() => 1;", timeoutMs: 800 }
	);
	assert.equal(waitSemicolon.ok, true, JSON.stringify(waitSemicolon));

	const brokenDump = scratchPath("n-a.dump");
	const broken = await run("ego_app_js", { name: "fake-space", expression: "1); evil(); (2" }, { env: { EGO_FAKE_DUMP: brokenDump } });
	assert.equal(broken.ok, false, JSON.stringify(broken));
	assert.match(String(broken.error ?? ""), /not valid JavaScript/);
	assert.equal(existsSync(brokenDump), false, "no CLI process may be spawned");
});

// ── N-c: app tab open reports whether the tab list actually grew ──
test("N-c: app tab open reports verified:true only when the tab list grew", async () => {
	const grown = await run(
		"ego_app_tabs",
		{ scope: "app", action: "open", name: "fake-space", url: "about:blank" },
		{ env: { EGO_FAKE_CREATETAB: "grow" } }
	);
	assert.equal(grown.ok, true, JSON.stringify(grown));
	assert.equal(grown.verified, true);

	const unchanged = await run("ego_app_tabs", { scope: "app", action: "open", name: "fake-space", url: "about:blank" });
	assert.equal(unchanged.ok, true, JSON.stringify(unchanged));
	assert.equal(unchanged.verified, false, "a createTab() that does not add a tab is not verified");
});

// ── N-f: a failing trigger click must still answer the dialog ──
test("N-f: a failing trigger click still answers the dialog, then reports the failure", async () => {
	const calls = scratchPath("n-f.calls");
	const out = await run(
		"ego_app_dialog",
		{ action: "accept", name: "fake-space", trigger: "#editable" },
		{ env: { EGO_FAKE_BREAK: "click", EGO_FAKE_CALLS: calls } }
	);
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /still answered/);
	assert.match(String(out.error ?? ""), /handled=true/);
	assert.equal(existsSync(calls), true, "the dialog must have been answered even though the click failed");
	assert.match(readFileSync(calls, "utf8"), /"call":"acceptDialog"/);
});

// ── N-g: a failed post-selection tab read leaves tabsSpaceId null ──
test("N-g: status leaves tabsSpaceId null when the post-selection tab read fails", async () => {
	const out = await run("ego_app_status", {}, { env: { EGO_FAKE_TABS: "unselected-fail" } });
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(out.data.tabsSpaceId, null, "a failed retry must not claim it verified a selected space");
	assert.match(String(out.data.tabsError ?? ""), /injected app tab read failure after selection/);
	assert.ok(Array.isArray(out.data.tabs));
});
