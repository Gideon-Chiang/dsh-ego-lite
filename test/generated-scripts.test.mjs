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
const run = async (toolName, args, { env = {}, exec = {}, config = {} } = {}) => {
	const tools = new Map();
	apply(
		{ tools: { register: (tool) => tools.set(tool.name, tool) }, systemPrompt: { section: () => {} } },
		{ executable: process.execPath, timeoutMs: 30000, maxOutputBytes: 1048576, announceToAgent: false, ...config }
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
	assert.match(String(waitOut.error ?? ""), /needs one valid expression or function source/);
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
	// R6: a trailing semicolon is not a statements body — `1+1;` evaluates to 2.
	assert.equal(exprSemicolon.value, 2, "1+1; must run as an expression and return its value");

	const statements = await run("ego_app_js", { name: "fake-space", expression: "const x=1; return x;" });
	assert.equal(statements.ok, true, JSON.stringify(statements));
	assert.equal(statements.value, 1, "a real statement body still runs as statements");

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

// ═══════════════════════════════════════════════════════════════════════════
// Fourth batch (contract R1–R10): Page prelude guards, same-name ambiguity,
// dialog double errors, app-open verified:null.
// ═══════════════════════════════════════════════════════════════════════════

// ── R1: the shared Page prelude fails readably instead of running blind ──
test("R1: a Page tool fails readably when pages/newPage/page are not usable", async () => {
	const pagesFailed = await run("ego_app_js", { name: "fake-space", expression: "1+1" }, { env: { EGO_FAKE_PAGES: "error" } });
	assert.equal(pagesFailed.ok, false, JSON.stringify(pagesFailed));
	assert.match(String(pagesFailed.error ?? ""), /TaskSpace page list is unreadable, so this Page cannot be resolved/);

	const pageFailed = await run("ego_app_js", { name: "fake-space", expression: "1+1" }, { env: { EGO_FAKE_PAGE: "no-label" } });
	assert.equal(pageFailed.ok, false, JSON.stringify(pageFailed));
	assert.match(String(pageFailed.error ?? ""), /page\(\) did not return a Page:.*no command ran against a Page/);

	const newPageFailed = await run(
		"ego_app_navigate",
		{ name: "fake-space", url: "about:blank", page: "p9" },
		{ env: { EGO_FAKE_NEWPAGE: "no-label" } }
	);
	assert.equal(newPageFailed.ok, false, JSON.stringify(newPageFailed));
	assert.match(String(newPageFailed.error ?? ""), /newPage\(\) did not return a Page:.*no command ran against a Page/);
});

// ── R2: same-name spaces are ambiguous; by-id stays usable; open refuses ──
test("R2: same-name spaces are refused, by-id still works, open refuses duplicates", async () => {
	const closeByName = await run("ego_app_space", { action: "close", name: "fake-space" }, { env: { EGO_FAKE_DUPLICATE: "1" } });
	assert.equal(closeByName.ok, false, JSON.stringify(closeByName));
	assert.match(String(closeByName.error ?? ""), /matches 2 spaces/);
	assert.match(String(closeByName.error ?? ""), /pass the space id instead/);

	const closeById = await run("ego_app_space", { action: "close", id: 9001 }, { env: { EGO_FAKE_DUPLICATE: "1" } });
	assert.equal(closeById.ok, true, JSON.stringify(closeById));
	assert.equal(closeById.spaceId, 9001);

	const openByName = await run("ego_app_space", { action: "open", name: "fake-space" }, { env: { EGO_FAKE_DUPLICATE: "1" } });
	assert.equal(openByName.ok, false, JSON.stringify(openByName));
	assert.match(String(openByName.error ?? ""), /matches 2 spaces/);
	assert.match(String(openByName.error ?? ""), /open the intended one by id instead/);
});

// ── R4: a throwing acceptDialog must not hide the trigger-click error ──
test("R4: both the trigger-click and the dialog-answer failures are reported", async () => {
	const out = await run(
		"ego_app_dialog",
		{ action: "accept", name: "fake-space", trigger: "#editable" },
		{ env: { EGO_FAKE_BREAK: "click", EGO_FAKE_ACCEPT: "error" } }
	);
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /trigger click failed: injected click failure/);
	assert.match(String(out.error ?? ""), /answering the dialog failed: injected acceptDialog failure/);
	assert.match(
		String(out.error ?? ""),
		/the dialog may still be open: retry ego_app_dialog without trigger, or reload the Page/
	);
});

// ── R5: a failed app-open pre-read yields verified:null, not false ──
test("R5: app tab open reports verified:null when the pre-read failed", async () => {
	const out = await run(
		"ego_app_tabs",
		{ scope: "app", action: "open", name: "fake-space", url: "about:blank" },
		{ env: { EGO_FAKE_TABS: "preread-fail" } }
	);
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(out.verified, null, "an unverifiable pre-read must not be reported as false");
});

// ── R7: structured successes surface the CLI log ──
test("R7: a structured success carries the CLI log when there is output", async () => {
	const noise = { EGO_FAKE_NOISE: "1" };

	const js = await run("ego_app_js", { name: "fake-space", expression: "1+1" }, { env: noise });
	assert.equal(js.ok, true, JSON.stringify(js));
	assert.equal(js.log, "fake-noise-line");

	const tabs = await run("ego_app_tabs", { scope: "app", name: "fake-space" }, { env: noise });
	assert.equal(tabs.ok, true, JSON.stringify(tabs));
	assert.equal(tabs.log, "fake-noise-line");

	const status = await run("ego_app_status", {}, { env: { ...noise, EGO_FAKE_TABS: "unselected" } });
	assert.equal(status.ok, true, JSON.stringify(status));
	assert.equal(status.log, "fake-noise-line");

	const quiet = await run("ego_app_js", { name: "fake-space", expression: "1+1" });
	assert.equal(quiet.ok, true, JSON.stringify(quiet));
	assert.equal("log" in quiet, false, "no CLI output means the log field stays absent");
});

// ── R8: an empty delete is refused on the host side, before any spawn ──
test("R8: delete{} is refused host-side without spawning", async () => {
	const dump = scratchPath("r8.dump");
	const out = await run("ego_app_space", { action: "delete" }, { env: { EGO_FAKE_DUMP: dump } });
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /never guesses which TaskSpace you mean/);
	assert.equal(typeof out.hint, "string");
	assert.equal(existsSync(dump), false, "no CLI process may be spawned");
});

// ── R9: a skipped running space gets its own message ──
test("R9: a skipped running space is reported as skipped, not as 'still listed'", async () => {
	const out = await run(
		"ego_app_space",
		{ action: "delete", ids: [9001] },
		{ env: { EGO_FAKE_OWNERSHIP: "user", EGO_FAKE_DELETE: "skipped" } }
	);
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /deleteSpaces\(\) skipped running space\(s\) 9001/);
	assert.match(String(out.error ?? ""), /close or finish them first, then retry the delete/);
	assert.doesNotMatch(String(out.error ?? ""), /were still listed after/);
	// N5: a skipped-only failure must also carry the space-specific hint.
	assert.equal(typeof out.hint, "string");
	assert.match(String(out.hint ?? ""), /ego only deletes spaces whose agent task has ended/);
});

// ── R10: 'Task space not selected' gets a dedicated hint ──
test("R10: 'Task space not selected' gets its own hint instead of the generic list hint", async () => {
	const out = await run("ego_app_space", { action: "pages", name: "fake-space" }, { env: { EGO_FAKE_LIST: "notselected" } });
	assert.equal(out.ok, false, JSON.stringify(out));
	const hint = String(out.hint ?? "");
	assert.match(hint, /no selected TaskSpace for this call/);
	assert.match(hint, /open\/use the space first/);
	assert.doesNotMatch(hint, /instead of its TaskSpace list/, "the generic unreadable-space hint must not win");
});

// ═══════════════════════════════════════════════════════════════════════════
// Fifth batch (contract N1 / N2 / N5)
// ═══════════════════════════════════════════════════════════════════════════

// ── N2: Page tools accept an id, which must beat ambiguous duplicate names ──
test("N2: Page tools accept an id and resolve that space despite duplicate names", async () => {
	const snapshot = await run("ego_app_snapshot", { id: 9001, scope: "viewport" }, { env: { EGO_FAKE_DUPLICATE: "1" } });
	assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
	assert.equal(snapshot.spaceId, 9001);

	const tabs = await run("ego_app_tabs", { scope: "space", id: 9001 }, { env: { EGO_FAKE_DUPLICATE: "1" } });
	assert.equal(tabs.ok, true, JSON.stringify(tabs));
	assert.equal(tabs.spaceId, 9001);

	// Without an id the ambiguity is still refused, not silently resolved.
	const snapshotByName = await run("ego_app_snapshot", { name: "fake-space", scope: "viewport" }, { env: { EGO_FAKE_DUPLICATE: "1" } });
	assert.equal(snapshotByName.ok, false, JSON.stringify(snapshotByName));
	assert.match(String(snapshotByName.error ?? ""), /matches 2 spaces/);

	const tabsByName = await run("ego_app_tabs", { scope: "space", name: "fake-space" }, { env: { EGO_FAKE_DUPLICATE: "1" } });
	assert.equal(tabsByName.ok, false, JSON.stringify(tabsByName));
	assert.match(String(tabsByName.error ?? ""), /matches 2 spaces/);
});

// ── N1: a structured success reports truncation instead of hiding it ──
test("N1: a truncated structured success carries log and truncated:true", async () => {
	const truncated = await run(
		"ego_app_js",
		{ name: "fake-space", expression: "1+1" },
		{ env: { EGO_FAKE_NOISE: "big" }, config: { maxOutputBytes: 256 } }
	);
	assert.equal(truncated.ok, true, JSON.stringify(truncated));
	assert.equal(truncated.truncated, true);
	assert.equal(typeof truncated.log, "string");
	assert.ok(truncated.log.length <= 256, `the kept log must respect maxOutputBytes (got ${truncated.log.length})`);

	const intact = await run("ego_app_js", { name: "fake-space", expression: "1+1" }, { config: { maxOutputBytes: 256 } });
	assert.equal(intact.ok, true, JSON.stringify(intact));
	assert.equal("truncated" in intact, false, "no truncation means no truncated field");
});

// ── N5: leftover AND skipped are reported together ──
test("N5: leftover and skipped are both reported when the delete leaves work", async () => {
	const out = await run(
		"ego_app_space",
		{ action: "delete", ids: [9001] },
		{ env: { EGO_FAKE_OWNERSHIP: "user", EGO_FAKE_DELETE: "skipped-leftover" } }
	);
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /were still listed after/);
	assert.match(String(out.error ?? ""), /ego skipped running space\(s\) 9001/);
	assert.match(String(out.error ?? ""), /close or finish them first, then retry the delete/);
	// Both diagnoses in one error still picks the skipped-space hint.
	assert.equal(typeof out.hint, "string");
	assert.match(String(out.hint ?? ""), /ego only deletes spaces whose agent task has ended/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Sixth batch (0.1.13 contract N4 / N6 / N7 / N9 / N2①)
// ═══════════════════════════════════════════════════════════════════════════

// ── N4: a default-parameter arrow must be the predicate, not a wrapped value ──
test("N4a: wait treats a default-parameter arrow as the predicate (false times out)", async () => {
	const falsePredicate = await run(
		"ego_app_wait",
		{ name: "fake-space", for: "function", expression: "(x = 0) => x > 0", timeoutMs: 800 }
	);
	assert.equal(falsePredicate.ok, false, JSON.stringify(falsePredicate));
	assert.match(String(falsePredicate.error ?? ""), /waitForFunction timed out/);

	const truePredicate = await run(
		"ego_app_wait",
		{ name: "fake-space", for: "function", expression: "(x = 1) => x > 0", timeoutMs: 800 }
	);
	assert.equal(truePredicate.ok, true, JSON.stringify(truePredicate));
});

// ── N4: regex literals inside the body must not unbalance the bracket lexer ──
test("N4b: wait treats a regex-literal arrow as the predicate (false times out)", async () => {
	const expression = "(x) => /" + String.fromCharCode(92) + ")/.test(x)";
	const out = await run("ego_app_wait", { name: "fake-space", for: "function", expression, timeoutMs: 800 });
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /waitForFunction timed out/);
});

// ── N6: the poll-budget wording is baked as a literal, never a runtime template ──
test("N6: generated scripts carry the literal '~2400 ms', not a runtime template", async () => {
	const dump = scratchPath("n6.dump");
	const out = await run("ego_app_space", { action: "close", name: "fake-space" }, { env: { EGO_FAKE_DUMP: dump } });
	assert.equal(out.ok, true, JSON.stringify(out));
	const script = lastScript(dump);
	assert.match(script, /within ~2400 ms/);
	assert.match(script, /after ~2400 ms/);
	assert.doesNotMatch(script, /SPACE_WATCH_TIMEOUT_MS/, "the constant name must not leak into the script");
	assert.doesNotMatch(script, /\$\{/, "no unresolved template expression may remain");
});

// ── N7: a non-string Page label is usable; a null label still fails ──
test("N7: a non-string Page label is usable; a null label still fails", async () => {
	const numeric = await run("ego_app_click", { name: "fake-space", selector: "#target" }, { env: { EGO_FAKE_PAGE: "label-number" } });
	assert.equal(numeric.ok, true, JSON.stringify(numeric));
	assert.equal(numeric.page, 42);

	const nullLabel = await run("ego_app_click", { name: "fake-space", selector: "#target" }, { env: { EGO_FAKE_PAGE: "label-null" } });
	assert.equal(nullLabel.ok, false, JSON.stringify(nullLabel));
	assert.match(String(nullLabel.error ?? ""), /page\(\) did not return a Page:.*no command ran against a Page/);
});

// ── N9: structured success log is capped; ego_app_run keeps the full log ──
test("N9a: structured success caps log at 16000 with logTruncated/logLength", async () => {
	const short = await run("ego_app_js", { name: "fake-space", expression: "1+1" }, { env: { EGO_FAKE_NOISE: "1" } });
	assert.equal(short.ok, true, JSON.stringify(short));
	assert.equal(short.log, "fake-noise-line");
	assert.equal("logTruncated" in short, false);
	assert.equal("logLength" in short, false);

	const long = await run("ego_app_js", { name: "fake-space", expression: "1+1" }, { env: { EGO_FAKE_NOISE: "huge" } });
	assert.equal(long.ok, true, JSON.stringify(long));
	assert.equal(typeof long.log, "string");
	assert.equal(long.log.length, 16000, "structured log is capped at 16000 characters");
	assert.equal(long.logTruncated, true);
	assert.equal(long.logLength, 20000, "logLength keeps the original length");
});

test("N9b: ego_app_run keeps the full log (documented contract)", async () => {
	const out = await run("ego_app_run", { script: 'console.log("y".repeat(20000));' });
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(typeof out.log, "string");
	assert.equal(out.log.length, 20000, "ego_app_run must not apply the structured log cap");
	assert.equal("logTruncated" in out, false);
});

// ── N2①: ego_app_space resolves by id first when both name and id are passed ──
test("N2①: ego_app_space resolves by id even when a name is also passed", async () => {
	const byId = await run("ego_app_space", { action: "pages", name: "fake-space", id: 9002 }, { env: { EGO_FAKE_SPACES: "idwins" } });
	assert.equal(byId.ok, true, JSON.stringify(byId));
	assert.equal(byId.spaceId, 9002, "id must win over the conflicting name");

	const byName = await run("ego_app_space", { action: "pages", name: "fake-space" }, { env: { EGO_FAKE_SPACES: "idwins" } });
	assert.equal(byName.ok, true, JSON.stringify(byName));
	assert.equal(byName.spaceId, 9001, "a unique name still resolves without an id");

	const openById = await run("ego_app_space", { action: "open", name: "brand-new", id: 9002 }, { env: { EGO_FAKE_SPACES: "idwins" } });
	assert.equal(openById.ok, true, JSON.stringify(openById));
	assert.equal(openById.spaceId, 9002);
});

// ═══════════════════════════════════════════════════════════════════════════
// Seventh batch (0.1.14 contract N4-a / N4-b): comment and keyword-regex lexing
// ═══════════════════════════════════════════════════════════════════════════

// ── N4-a: a commented false predicate must really time out, not pass instantly ──
test("N4-a: a commented false predicate times out instead of passing instantly", async () => {
	const dump = scratchPath("n4a.dump");
	const expression = "(x) => { // c\n return x > 5; }";
	const out = await run(
		"ego_app_wait",
		{ name: "fake-space", for: "function", expression, timeoutMs: 600 },
		{ env: { EGO_FAKE_DUMP: dump } }
	);
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /waitForFunction timed out after 600ms/);
	const script = lastScript(dump);
	assert.match(script, /timeout: 600/);
	assert.match(script, /\/\/ c/);
});

// ── N4-b: a regex after a keyword is skipped, so the predicate is the bare source ──
test("N4-b: a keyword-regex predicate is a bare function source", async () => {
	const dump = scratchPath("n4b.dump");
	const expression = "(x) => { return /}/.test(x); }";
	const out = await run(
		"ego_app_wait",
		{ name: "fake-space", for: "function", expression, timeoutMs: 800 },
		{ env: { EGO_FAKE_DUMP: dump } }
	);
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /waitForFunction timed out/);
	const script = lastScript(dump);
	assert.ok(
		script.includes("typeof __v === \"function\""),
		"the predicate must be the 0.1.15 value probe (evaluate, call only when it is a function)"
	);
	assert.ok(
		!script.includes("waitForFunction(() => (("),
		"the old expression wrapper would make the arrow itself truthy and pass on the first poll"
	);
	assert.ok(script.includes("/}/.test(x)"), "the regex literal must survive into the generated script");
});

// ── N4: a comment-bearing true predicate still passes ──
test("N4: a comment-bearing true predicate still passes", async () => {
	const expression = "(x = 1) => { /* keep */ return x > 0; }";
	const out = await run("ego_app_wait", { name: "fake-space", for: "function", expression, timeoutMs: 600 });
	assert.equal(out.ok, true, JSON.stringify(out));
});

// ═══════════════════════════════════════════════════════════════════════════
// 0.1.15: parser oracle + value probe
// ═══════════════════════════════════════════════════════════════════════════

test("P1: a trailing semicolon is a value, not a statement body", async () => {
	const expr = await run("ego_app_js", { name: "fake-space", expression: "1+1;" });
	assert.equal(expr.ok, true, JSON.stringify(expr));
	assert.equal(expr.value, 2, "`1+1;` must evaluate as an expression");

	const arrow = await run("ego_app_js", { name: "fake-space", expression: "() => 1;" });
	assert.equal(arrow.ok, true, JSON.stringify(arrow));
	assert.equal(arrow.value, 1, "`() => 1;` must still be called");

	const fnWithArg = await run("ego_app_js", { name: "fake-space", fn: "(x) => x + 1;", arg: 41 });
	assert.equal(fnWithArg.ok, true, JSON.stringify(fnWithArg));
	assert.equal(fnWithArg.value, 42, "`fn:` with a trailing semicolon must still receive the arg");

	const waitSemi = await run("ego_app_wait", { name: "fake-space", for: "function", expression: "() => 1;", timeoutMs: 400 });
	assert.equal(waitSemi.ok, true, JSON.stringify(waitSemi));
});

test("P2: an empty js source is refused instead of silently evaluating nothing", async () => {
	const missing = await run("ego_app_js", { name: "fake-space" });
	assert.equal(missing.ok, false, JSON.stringify(missing));
	assert.match(String(missing.error ?? ""), /expression is required/);

	const blank = await run("ego_app_js", { name: "fake-space", expression: "   " });
	assert.equal(blank.ok, false, JSON.stringify(blank));
	assert.match(String(blank.error ?? ""), /expression is required/);

	const withFn = await run("ego_app_js", { name: "fake-space", fn: "() => 7" });
	assert.equal(withFn.ok, true, JSON.stringify(withFn));
	assert.equal(withFn.value, 7);
});

test("P3: explicit expression mode never calls the source and reports a function value", async () => {
	const explicit = await run("ego_app_js", { name: "fake-space", expression: "() => 1", mode: "expression" });
	assert.equal(explicit.ok, true, JSON.stringify(explicit));
	assert.equal(explicit.value, null, "a function value cannot travel as JSON");
	assert.equal(explicit.valueType, "function");
	assert.match(String(explicit.note ?? ""), /evaluated to a function/);

	const called = await run("ego_app_js", { name: "fake-space", expression: "() => 1", mode: "function" });
	assert.equal(called.ok, true, JSON.stringify(called));
	assert.equal(called.value, 1);
});

test("P4: statement bodies run and a function-valued result is reported", async () => {
	const body = await run("ego_app_js", { name: "fake-space", mode: "statements", expression: "const x = 1; return x;" });
	assert.equal(body.ok, true, JSON.stringify(body));
	assert.equal(body.value, 1);

	const auto = await run("ego_app_js", { name: "fake-space", expression: "const x = 1; return x;" });
	assert.equal(auto.ok, true, JSON.stringify(auto));
	assert.equal(auto.value, 1, "auto must fall back to statements when the source is not an expression");

	const returnsFunction = await run("ego_app_js", { name: "fake-space", mode: "statements", expression: "const f = () => 1; return f;" });
	assert.equal(returnsFunction.ok, true, JSON.stringify(returnsFunction));
	assert.equal(returnsFunction.value, null);
	assert.equal(returnsFunction.valueType, "function");
});

test("P5: a source that would escape the wrapper is refused before spawning", async () => {
	const jsDump = scratchPath("p5-js.dump");
	const escaped = await run("ego_app_js", { name: "fake-space", expression: "1); evil(); (2" }, { env: { EGO_FAKE_DUMP: jsDump } });
	assert.equal(escaped.ok, false, JSON.stringify(escaped));
	assert.match(String(escaped.error ?? ""), /not valid JavaScript|single valid expression/);
	assert.equal(existsSync(jsDump), false, "no CLI process may be spawned");

	const waitDump = scratchPath("p5-wait.dump");
	const waitEscaped = await run(
		"ego_app_wait",
		{ name: "fake-space", for: "function", expression: "1); evil(); (2", timeoutMs: 400 },
		{ env: { EGO_FAKE_DUMP: waitDump } }
	);
	assert.equal(waitEscaped.ok, false, JSON.stringify(waitEscaped));
	assert.match(String(waitEscaped.error ?? ""), /not a single expression/);
	assert.equal(existsSync(waitDump), false, "no CLI process may be spawned");
});

test("P6: auto mode evaluates expressions and calls function values", async () => {
	const plain = await run("ego_app_js", { name: "fake-space", expression: "1 + 1" });
	assert.equal(plain.ok, true, JSON.stringify(plain));
	assert.equal(plain.value, 2);

	const object = await run("ego_app_js", { name: "fake-space", expression: "() => ({ a: 1 })" });
	assert.equal(object.ok, true, JSON.stringify(object));
	assert.deepEqual(object.value, { a: 1 });

	const withArg = await run("ego_app_js", { name: "fake-space", expression: "(x) => x * 2", arg: 21 });
	assert.equal(withArg.ok, true, JSON.stringify(withArg));
	assert.equal(withArg.value, 42);

	const globals = await run("ego_app_js", { name: "fake-space", expression: "Math.max(1, 2)" });
	assert.equal(globals.ok, true, JSON.stringify(globals));
	assert.equal(globals.value, 2);
});

test("P7: the wait predicate is a probe, so false predicates keep polling", async () => {
	const falseArrow = await run("ego_app_wait", { name: "fake-space", for: "function", expression: "() => false", timeoutMs: 200 });
	assert.equal(falseArrow.ok, false, JSON.stringify(falseArrow));
	assert.match(String(falseArrow.error ?? ""), /waitForFunction timed out/);

	const falseFn = await run("ego_app_wait", { name: "fake-space", for: "function", expression: "(x = 1) => x > 5", timeoutMs: 200 });
	assert.equal(falseFn.ok, false, JSON.stringify(falseFn));
	assert.match(String(falseFn.error ?? ""), /waitForFunction timed out/);

	const trueFn = await run("ego_app_wait", { name: "fake-space", for: "function", expression: "(x = 1) => x > 0", timeoutMs: 400 });
	assert.equal(trueFn.ok, true, JSON.stringify(trueFn));

	const expression = await run("ego_app_wait", { name: "fake-space", for: "function", expression: "1 + 1", timeoutMs: 400 });
	assert.equal(expression.ok, true, JSON.stringify(expression));

	const commented = await run("ego_app_wait", { name: "fake-space", for: "function", expression: "(x) => { // c\n return x > 5; }", timeoutMs: 200 });
	assert.equal(commented.ok, false, JSON.stringify(commented));
	assert.match(String(commented.error ?? ""), /waitForFunction timed out/);
});

test("P8: async results are awaited before the function-value check", async () => {
	const asyncArrow = await run("ego_app_js", { name: "fake-space", expression: "async () => () => 1" });
	assert.equal(asyncArrow.ok, true, JSON.stringify(asyncArrow));
	assert.equal(asyncArrow.value, null, "a function that resolves to a function must be reported, not dropped");
	assert.equal(asyncArrow.valueType, "function");

	const promiseExpression = await run("ego_app_js", { name: "fake-space", expression: "() => Promise.resolve(() => 1)", mode: "expression" });
	assert.equal(promiseExpression.ok, true, JSON.stringify(promiseExpression));
	assert.equal(promiseExpression.value, null);
	assert.equal(promiseExpression.valueType, "function");

	const asyncFn = await run("ego_app_js", { name: "fake-space", fn: "async (x) => x + 1", arg: 1 });
	assert.equal(asyncFn.ok, true, JSON.stringify(asyncFn));
	assert.equal(asyncFn.value, 2, "an async fn: result must be awaited");
});

test("P9: a semicolon-only source is still an empty source", async () => {
	const onlySemicolon = await run("ego_app_js", { name: "fake-space", expression: ";" });
	assert.equal(onlySemicolon.ok, false, JSON.stringify(onlySemicolon));
	assert.match(String(onlySemicolon.error ?? ""), /expression is required/);

	const twoSemicolons = await run("ego_app_js", { name: "fake-space", expression: ";;" });
	assert.equal(twoSemicolons.ok, false, JSON.stringify(twoSemicolons));
	assert.match(String(twoSemicolons.error ?? ""), /expression is required/);
});

test("P10: a statements body may end with a line comment", async () => {
	const commented = await run("ego_app_js", { name: "fake-space", mode: "statements", expression: "const a = 1; // note" });
	assert.equal(commented.ok, true, JSON.stringify(commented));
	assert.equal(commented.value, undefined, "the body returns nothing; the call still succeeds");

	const value = await run("ego_app_js", { name: "fake-space", mode: "statements", expression: "const a = 1; return a; // note" });
	assert.equal(value.ok, true, JSON.stringify(value));
	assert.equal(value.value, 1);
});

test("P11: a Promise that resolves to a function is reported in auto mode too", async () => {
	const promiseFn = await run("ego_app_js", { name: "fake-space", expression: "Promise.resolve(() => 1)" });
	assert.equal(promiseFn.ok, true, JSON.stringify(promiseFn));
	assert.equal(promiseFn.value, null, "auto must await the expression before deciding it is not a plain value");
	assert.equal(promiseFn.valueType, "function");

	const iife = await run("ego_app_js", { name: "fake-space", expression: "(async () => () => 1)()" });
	assert.equal(iife.ok, true, JSON.stringify(iife));
	assert.equal(iife.value, null);
	assert.equal(iife.valueType, "function");
});

test("P12: comment-only and semicolon-only sources are empty", async () => {
	for (const expression of ["; ;", ";\n;", "; // c", "/*c*/;"]) {
		const out = await run("ego_app_js", { name: "fake-space", expression });
		assert.equal(out.ok, false, expression + " -> " + JSON.stringify(out));
		assert.match(String(out.error ?? ""), /expression is required/, expression);
	}
	const waitEmpty = await run("ego_app_wait", { name: "fake-space", for: "function", expression: ";", timeoutMs: 300 });
	assert.equal(waitEmpty.ok, false, JSON.stringify(waitEmpty));
	assert.match(String(waitEmpty.error ?? ""), /expression is required/);
});

test("P13: an empty-source guard stays linear on many block comments (no ReDoS)", async () => {
	const noisy = "/*a*/".repeat(28) + "1+1";
	const started = Date.now();
	const out = await run("ego_app_js", { name: "fake-space", expression: noisy });
	const elapsed = Date.now() - started;
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.equal(out.value, 2);
	assert.ok(elapsed < 2000, `guard must be linear, took ${elapsed} ms`);

	const empty = await run("ego_app_js", { name: "fake-space", expression: "/*a*/".repeat(28) + ";" });
	assert.equal(empty.ok, false, JSON.stringify(empty));
	assert.match(String(empty.error ?? ""), /expression is required/);

	const mixed = await run("ego_app_js", { name: "fake-space", expression: "/*a*/; // b\n".repeat(26) + "x" });
	// Not empty: it runs as a statement body, so the unknown identifier is a runtime
	// error — the guard only answers "is there any code here?".
	assert.equal(mixed.ok, false, JSON.stringify(mixed));
	assert.match(String(mixed.error ?? ""), /x is not defined/);
});

// ── P14: every ECMAScript line terminator ends a line comment ──
test("P14: a line comment ends at CR, U+2028 and CRLF, not only at LF", async () => {
	// The empty-source guard used to end comments at "\n" only, so real code after a
	// lone CR or U+2028 was rejected as "expression is required".
	for (const expression of ["// c\r1", "// c\u20281", "// c\r\n1"]) {
		const out = await run("ego_app_js", { name: "fake-space", expression });
		assert.equal(out.ok, true, JSON.stringify(expression) + " -> " + JSON.stringify(out));
		assert.equal(out.value, 1, JSON.stringify(expression));
	}

	const onlyComment = await run("ego_app_js", { name: "fake-space", expression: "// c\r" });
	assert.equal(onlyComment.ok, false, JSON.stringify(onlyComment));
	assert.match(String(onlyComment.error ?? ""), /expression is required/);
});

// ── P15: a forged function-value marker is data, not a lost value ──
test("P15: page data that merely looks like the function marker is returned intact", async () => {
	const forged = await run("ego_app_js", { name: "fake-space", expression: "({__dshFunctionValue:true, secret:42})" });
	assert.equal(forged.ok, true, JSON.stringify(forged));
	assert.deepEqual(forged.value, { __dshFunctionValue: true, secret: 42 });
	assert.equal("valueType" in forged, false, "a forged marker must not turn the value into an unreportable function");

	const realFunction = await run("ego_app_js", { name: "fake-space", expression: "() => 1", mode: "expression" });
	assert.equal(realFunction.ok, true, JSON.stringify(realFunction));
	assert.equal(realFunction.value, null, "a real function value cannot travel as JSON; it is reported, not dropped");
	assert.equal(realFunction.valueType, "function");
});

// ── P16: fn/mode conflicts and arg misuse are rejected before any spawn ──
test("P16: fn/mode conflicts and arg misuse are rejected with nothing ran", async () => {
	const rejected = [
		{ args: { fn: "(x)=>x", arg: 2, mode: "expression" }, pattern: /contradict|silently ignored/ },
		{ args: { expression: "return 1", mode: "statements", arg: 9 }, pattern: /arg cannot be used with mode:"statements"/ },
		{ args: { expression: "(x)=>x", mode: "expression", arg: 2 }, pattern: /arg cannot be used with mode:"expression"/ }
	];
	for (const { args, pattern } of rejected) {
		const dump = scratchPath("p16.dump");
		const out = await run("ego_app_js", { name: "fake-space", ...args }, { env: { EGO_FAKE_DUMP: dump } });
		assert.equal(out.ok, false, JSON.stringify(args) + " -> " + JSON.stringify(out));
		assert.match(String(out.error ?? ""), pattern, JSON.stringify(args));
		assert.equal(existsSync(dump), false, "no CLI process may be spawned: " + JSON.stringify(args));
	}

	const fnCalled = await run("ego_app_js", { name: "fake-space", fn: "(x)=>x*3", arg: 4, mode: "function" });
	assert.equal(fnCalled.ok, true, JSON.stringify(fnCalled));
	assert.equal(fnCalled.value, 12);

	const autoCalled = await run("ego_app_js", { name: "fake-space", expression: "(x)=>x*3", arg: 4 });
	assert.equal(autoCalled.ok, true, JSON.stringify(autoCalled));
	assert.equal(autoCalled.value, 12);
});

// ── P17: comment-only wait sources share one message (P12 covers ";") ──
test("P17: every comment-only wait source reports the same 'expression is required'", async () => {
	for (const expression of ["; ;", "// c", "/*c*/;"]) {
		const dump = scratchPath("p17.dump");
		const out = await run("ego_app_wait", { name: "fake-space", for: "function", expression, timeoutMs: 300 }, { env: { EGO_FAKE_DUMP: dump } });
		assert.equal(out.ok, false, JSON.stringify(expression) + " -> " + JSON.stringify(out));
		assert.match(String(out.error ?? ""), /expression is required for for="function"/, JSON.stringify(expression));
		assert.equal(existsSync(dump), false, "no CLI process may be spawned: " + JSON.stringify(expression));
	}
});

// ── P18: an unusable parameter is rejected instead of ignored ──
test("P18: an unusable parameter is rejected instead of ignored (nothing ran)", async () => {
	const rejected = [
		["ego_app_key", { action: "press", selector: "#x" }],
		["ego_app_key", { action: "type", text: "x", selector: "#x" }],
		["ego_app_pointer", { action: "move" }],
		["ego_app_pointer", { action: "scroll" }],
		["ego_app_pointer", { action: "scroll", deltaY: 100, x: 10 }],
		["ego_app_page", { action: "fetch" }],
		["ego_app_page", { action: "close", files: ["C:/a.txt"] }],
		["ego_app_page", { action: "fetch", url: "https://example.com", timeoutMs: 5000 }]
	];
	for (const [toolName, args] of rejected) {
		const label = toolName + " " + JSON.stringify(args);
		const dump = scratchPath("p18.dump");
		const out = await run(toolName, { name: "fake-space", ...args }, { env: { EGO_FAKE_DUMP: dump } });
		assert.equal(out.ok, false, label + " -> " + JSON.stringify(out));
		assert.match(String(out.error ?? ""), /nothing ran/, label);
		assert.equal(existsSync(dump), false, "no CLI process may be spawned: " + label);
	}

	// The same actions with their required parameter still work.
	const pressed = await run("ego_app_key", { name: "fake-space", action: "press", key: "Enter" });
	assert.equal(pressed.ok, true, JSON.stringify(pressed));

	const moved = await run("ego_app_pointer", { name: "fake-space", action: "move", x: 10, y: 20 });
	assert.equal(moved.ok, true, JSON.stringify(moved));
});

// ── P19: gesture coordinates, and the echoed default command ──
test("P19: gesture coordinates are required and the default command is echoed", async () => {
	const missing = await run("ego_app_gesture", { name: "fake-space", action: "highlight" });
	assert.equal(missing.ok, false, JSON.stringify(missing));
	assert.match(String(missing.error ?? ""), /highlight needs x and y/);

	const highlighted = await run("ego_app_gesture", { name: "fake-space", action: "highlight", x: 1, y: 2 });
	assert.equal(highlighted.ok, true, JSON.stringify(highlighted));
	assert.deepEqual(highlighted.point, { x: 1, y: 2 });

	const defaulted = await run("ego_app_gesture", { name: "fake-space", action: "gesture" });
	assert.equal(defaulted.ok, true, JSON.stringify(defaulted));
	assert.deepEqual(defaulted.command, { type: "think", label: "working" });
});

// ── P20: finish rejects conflicting keep inputs, accepts keepPages: [] ──
test("P20: finish rejects conflicting keep inputs and accepts an explicit empty keepPages", async () => {
	const dump = scratchPath("p20.dump");
	const conflict = await run(
		"ego_app_space",
		{ action: "finish", name: "fake-space", keep: true, keepPages: ["p1"] },
		{ env: { EGO_FAKE_DUMP: dump } }
	);
	assert.equal(conflict.ok, false, JSON.stringify(conflict));
	assert.match(String(conflict.error ?? ""), /either keep|keepPages already decides/);
	assert.equal(existsSync(dump), false, "no CLI process may be spawned");

	// An explicit [] means "keep none" — it must not be treated as absent.
	const emptyKeepPages = await run("ego_app_space", { action: "finish", name: "fake-space", keepPages: [] });
	assert.equal(emptyKeepPages.ok, true, JSON.stringify(emptyKeepPages));
});

// ── P21: fn: and expression: are two sources; a dropped one is rejected ──
test("P21: fn: and expression: are rejected together unless expression: says nothing", async () => {
	// fn: always wins, so a non-empty expression: used to be dropped without a trace.
	const dump = scratchPath("p21.dump");
	const conflict = await run(
		"ego_app_js",
		{ name: "fake-space", fn: "(arg) => arg.n", expression: "999", arg: { n: 7 } },
		{ env: { EGO_FAKE_DUMP: dump } }
	);
	assert.equal(conflict.ok, false, JSON.stringify(conflict));
	assert.match(String(conflict.error ?? ""), /fn: and expression:/);
	assert.equal(existsSync(dump), false, "no CLI process may be spawned");

	// A comment-only expression: is not a second source, so fn: still runs.
	const commentOnly = await run("ego_app_js", { name: "fake-space", fn: "(x) => x + 1", expression: "/* nothing */", arg: 1 });
	assert.equal(commentOnly.ok, true, JSON.stringify(commentOnly));
	assert.equal(commentOnly.value, 2);
});

// ── P22: arg is rejected where the source is never called (auto fallback too) ──
test("P22: arg with an auto statements fallback is rejected, and statements mode keeps its wording", async () => {
	// No mode: auto could not parse the body as one expression, so it fell back to
	// statements and arg was silently dropped.
	const dump = scratchPath("p22.dump");
	const fallback = await run(
		"ego_app_js",
		{ name: "fake-space", expression: "const x = 1; return x;", arg: { k: 1 } },
		{ env: { EGO_FAKE_DUMP: dump } }
	);
	assert.equal(fallback.ok, false, JSON.stringify(fallback));
	assert.match(String(fallback.error ?? ""), /auto statements fallback/);
	assert.equal(existsSync(dump), false, "no CLI process may be spawned");

	// A function source in auto mode is called, so arg reaches it.
	const autoCalled = await run("ego_app_js", { name: "fake-space", expression: "(x) => x * 3", arg: 4 });
	assert.equal(autoCalled.ok, true, JSON.stringify(autoCalled));
	assert.equal(autoCalled.value, 12);

	// The explicit-statements message keeps its own wording (not the fallback one).
	const explicit = await run("ego_app_js", { name: "fake-space", expression: "return 1", mode: "statements", arg: 9 });
	assert.equal(explicit.ok, false, JSON.stringify(explicit));
	assert.match(String(explicit.error ?? ""), /arg cannot be used with mode:"statements"/);
});

// ── P23: a clamped dialog waitMs is echoed, never silently shortened ──
test("P23: dialog waitMs echoes requested/applied/clamped, and is absent when unset", async () => {
	// The 30 s cap protects the CLI budget, but a truncated delay must not look honoured.
	const capped = await run("ego_app_dialog", { action: "accept", name: "fake-space", trigger: "#btn", waitMs: 60000 });
	assert.equal(capped.ok, true, JSON.stringify(capped));
	assert.deepEqual(capped.waitMs, { requested: 60000, applied: 30000, clamped: true });

	// Under the cap, requested and applied agree and clamped is false.
	const honoured = await run("ego_app_dialog", { action: "accept", name: "fake-space", trigger: "#btn", waitMs: 500 });
	assert.equal(honoured.ok, true, JSON.stringify(honoured));
	assert.deepEqual(honoured.waitMs, { requested: 500, applied: 500, clamped: false });

	// The default 400 ms is not a caller-visible value, so there is nothing to echo.
	const defaulted = await run("ego_app_dialog", { action: "accept", name: "fake-space" });
	assert.equal(defaulted.ok, true, JSON.stringify(defaulted));
	assert.equal("waitMs" in defaulted, false, "waitMs is only echoed when the caller passed it");
});

// ── P24: select's index must not silently override label/value ──
test("P24: select rejects index combined with label/value", async () => {
	for (const extra of [{ label: "Foo" }, { value: "bar" }]) {
		const dump = scratchPath("p24.dump");
		const out = await run("ego_app_select", { name: "fake-space", selector: "#s", index: 0, ...extra }, { env: { EGO_FAKE_DUMP: dump } });
		assert.equal(out.ok, false, JSON.stringify(extra) + " -> " + JSON.stringify(out));
		assert.match(String(out.error ?? ""), /index cannot be combined/);
		assert.equal(existsSync(dump), false, "no CLI process may be spawned: " + JSON.stringify(extra));
	}
	// The documented label-wins-over-value pair is unchanged.
	const labelWins = await run("ego_app_select", { name: "fake-space", selector: "#s", label: "Foo", value: "bar" });
	assert.equal(labelWins.ok, true, JSON.stringify(labelWins));
	const byIndex = await run("ego_app_select", { name: "fake-space", selector: "#s", index: 0 });
	assert.equal(byIndex.ok, true, JSON.stringify(byIndex));
});

// ── P25: an invalid wait_event name is named before the parameter allow-list ──
test("P25: wait_event validates the event name before reporting unused parameters", async () => {
	const dump = scratchPath("p25.dump");
	const out = await run("ego_app_page", { name: "fake-space", action: "wait_event", event: "bogus", saveAs: "C:/x.png" }, { env: { EGO_FAKE_DUMP: dump } });
	assert.equal(out.ok, false, JSON.stringify(out));
	assert.match(String(out.error ?? ""), /only supports the "popup" and "download"/);
	assert.equal(existsSync(dump), false, "no CLI process may be spawned");
});
