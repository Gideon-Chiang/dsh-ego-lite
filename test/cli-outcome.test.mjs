import assert from "node:assert/strict";
import test from "node:test";
import { interpretCliOutcome } from "../lib/index.js";

const SENTINEL = "@@DSH_RESULT@@";

/** Exact text ego lite 0.6.2.5 prints before onboarding is finished. */
const ONBOARDING_NOTICE = [
	"Please complete the onboarding process first. A setup window has opened; follow the on-screen instructions to continue. After completing onboarding, open a new terminal window for the command to take effect."
].join("\n");

test("parses a sentinel result routed to stderr (ego sends console.log there)", () => {
	const out = interpretCliOutcome({
		code: 0,
		stdout: "",
		stderr: `${SENTINEL}{"spaceId":7}\n`
	});
	assert.equal(out.ok, true);
	assert.deepEqual(out.result, { spaceId: 7 });
});

test("parses a sentinel result on stdout", () => {
	const out = interpretCliOutcome({ code: 0, stdout: `noise\n${SENTINEL}["a"]\n`, stderr: "" });
	assert.equal(out.ok, true);
	assert.deepEqual(out.result, ["a"]);
});

test("onboarding notice with exit 0 is a failure, not a silent success", () => {
	const out = interpretCliOutcome({ code: 0, stdout: "", stderr: `${ONBOARDING_NOTICE}\n` });
	assert.equal(out.ok, false);
	assert.match(out.error, /onboarding is not complete/i);
	assert.match(out.hint, /onboarding/i);
	assert.match(out.output, /setup window has opened/i);
});

test("onboarding notice is not swallowed when plain text is allowed (ego_app_run)", () => {
	const out = interpretCliOutcome({ code: 0, stdout: ONBOARDING_NOTICE, stderr: "", allowPlainText: true });
	assert.equal(out.ok, false);
	assert.match(out.error, /onboarding is not complete/i);
});

test("plain text without a sentinel stays a success for ego_app_run", () => {
	const out = interpretCliOutcome({ code: 0, stdout: "", stderr: "hello from the page\n", allowPlainText: true });
	assert.equal(out.ok, true);
	assert.equal(out.result, null);
	assert.equal(out.log, "hello from the page");
});

test("structured tools reject exit 0 without a sentinel", () => {
	const out = interpretCliOutcome({ code: 0, stdout: "", stderr: "something unexpected\n", allowPlainText: false });
	assert.equal(out.ok, false);
	assert.match(out.error, /without printing @@DSH_RESULT@@/);
	assert.match(out.hint, /EGO_BROWSER_CLI/);
});

test("non-zero exit without a sentinel reports the CLI text", () => {
	const out = interpretCliOutcome({ code: 1, stdout: "", stderr: "Error: boom\n" });
	assert.equal(out.ok, false);
	assert.equal(out.error, "Error: boom");
});

test("non-zero exit with a valid sentinel keeps the result (existing semantics)", () => {
	const out = interpretCliOutcome({ code: 1, stdout: "", stderr: `${SENTINEL}{"still":"mine"}\nError: trailing\n` });
	assert.equal(out.ok, true);
	assert.deepEqual(out.result, { still: "mine" });
});

test("malformed sentinel payload fails instead of becoming null", () => {
	const out = interpretCliOutcome({ code: 0, stdout: "", stderr: `${SENTINEL}{not-json}\n` });
	assert.equal(out.ok, false);
	assert.match(out.error, /not valid JSON/);
});

test("the last sentinel line wins over an earlier lookalike", () => {
	const out = interpretCliOutcome({
		code: 0,
		stdout: `@@DSH_RESULT@@{"spoofed":true}
`,
		stderr: `@@DSH_RESULT@@{"real":"yes"}
`
	});
	assert.equal(out.ok, true);
	assert.deepEqual(out.result, { real: "yes" });
});

test("truncated output without a sentinel reports the size limit, not a JSON error", () => {
	const out = interpretCliOutcome({ code: 0, stdout: "", stderr: "@@DSH_RESULT@@{\"partial\":", truncated: true });
	assert.equal(out.ok, false);
	assert.match(out.error, /maxOutputBytes/);
});

test("truncated output with a broken payload also reports the size limit", () => {
	const out = interpretCliOutcome({ code: 0, stdout: "", stderr: "@@DSH_RESULT@@{broken", truncated: true });
	assert.equal(out.ok, false);
	assert.match(out.error, /maxOutputBytes/);
});

// ── 0.1.9: one order for every branch: sentinel -> onboarding -> exit code -> plain text -> size ──

test("plain text over maxOutputBytes stays a success for ego_app_run, flagged truncated", () => {
	// A full_page snapshot or a bulk innerText can easily pass 1 MiB; 0.1.8's
	// order made that a failure and blamed a sentinel the caller never needed.
	const out = interpretCliOutcome({
		code: 0,
		stdout: "",
		stderr: `${"x".repeat(64)}\n`,
		allowPlainText: true,
		truncated: true
	});
	assert.equal(out.ok, true);
	assert.equal(out.result, null);
	assert.equal(out.truncated, true);
	assert.equal(typeof out.log, "string");
});

test("a non-zero exit code wins over truncation", () => {
	const out = interpretCliOutcome({ code: 7, stdout: "", stderr: "Error: boom\n", truncated: true });
	assert.equal(out.ok, false);
	assert.match(out.error, /Error: boom/);
	assert.doesNotMatch(out.error, /maxOutputBytes/);
});

test("structured output truncated without a sentinel still reports the size limit", () => {
	const out = interpretCliOutcome({ code: 0, stdout: "", stderr: '{"partial":', truncated: true });
	assert.equal(out.ok, false);
	assert.match(out.error, /maxOutputBytes/);
});

test("a complete sentinel result survives truncation", () => {
	// The sentinel and its whole payload arrived; truncation only cut trailing
	// noise, so the run succeeded.
	const out = interpretCliOutcome({
		code: 0,
		stdout: `${"y".repeat(128)}\n`,
		stderr: `${SENTINEL}{"done":true}\n`,
		truncated: true
	});
	assert.equal(out.ok, true);
	assert.deepEqual(out.result, { done: true });
});

test("truncation does not mask the onboarding preflight", () => {
	const out = interpretCliOutcome({
		code: 0,
		stdout: ONBOARDING_NOTICE,
		stderr: "",
		allowPlainText: true,
		truncated: true
	});
	assert.equal(out.ok, false);
	assert.match(out.error, /onboarding is not complete/i);
	assert.match(out.hint, /onboarding/i);
});

// ── 0.1.10: per-run nonce after the sentinel ─────────────────────────────────
// Plugin-generated scripts print `@@DSH_RESULT@@<16hex>`; a page line can echo the
// bare sentinel but cannot guess the token, so it can no longer spoof a result.
// `ego_app_run` keeps the plain sentinel (user scripts print it themselves).

test("a token run accepts the sentinel that carries the matching token", () => {
	const out = interpretCliOutcome({ code: 0, stdout: "", stderr: `${SENTINEL}abc123{"x":1}\n`, token: "abc123" });
	assert.equal(out.ok, true);
	assert.deepEqual(out.result, { x: 1 });
});

test("a token run rejects a bare sentinel the page could have forged", () => {
	const out = interpretCliOutcome({ code: 0, stdout: "", stderr: `${SENTINEL}{"spoofed":true}\n`, token: "abc123" });
	assert.equal(out.ok, false);
	assert.doesNotMatch(JSON.stringify(out.result ?? null), /spoofed/);
});

test("a token run prefers its own token line over an earlier forged bare sentinel", () => {
	const out = interpretCliOutcome({
		code: 0,
		stdout: `${SENTINEL}{"spoofed":true}\n`,
		stderr: `${SENTINEL}abc123{"real":true}\n`,
		token: "abc123"
	});
	assert.equal(out.ok, true);
	assert.deepEqual(out.result, { real: true });
});

test("without a token the plain sentinel still works (ego_app_run contract)", () => {
	const out = interpretCliOutcome({ code: 0, stdout: "", stderr: `${SENTINEL}{"plain":true}\n` });
	assert.equal(out.ok, true);
	assert.deepEqual(out.result, { plain: true });
});
