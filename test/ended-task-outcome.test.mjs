/**
 * Unit tests for decideEndedTaskOutcome — the decision table used when ego ends
 * the agent task as a consequence of an action and hard-stops the script,
 * discarding its output ("this task space is no longer assigned to the agent",
 * "its task has ended" / "browser commands are paused", exit 0, no sentinel).
 *
 * The live regression this locks down: a successful close/finish/complete/
 * mark_error was reported as "the script never ran", i.e. exactly the class of
 * false negative 0.1.9 is meant to remove. The caller supplies an independent
 * listTaskSpaces() read; success is only claimed when that observation matches
 * what the action promises.
 *
 * 0.1.9 S2 fix: an action whose target state is already observed is a success,
 * not a failure — the task ending mid-script does not make "handed off" or
 * "control is back with the agent" untrue.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { decideEndedTaskOutcome } from "../lib/index.js";

test("close with the space gone is a verified success", () => {
	const out = decideEndedTaskOutcome({ action: "close", space: "e2e-space", spaceId: 7, listed: false, ownership: "closed" });
	assert.equal(out.ok, true);
	assert.equal(out.closed, true);
	assert.equal(out.ownership, "closed");
	assert.equal(out.verifiedBy, "listTaskSpaces");
	assert.equal(out.receipt, null);
	assert.equal(out.spaceId, 7);
	assert.equal(typeof out.note, "string");
});

test("close with the space still listed is a failure that says so", () => {
	const out = decideEndedTaskOutcome({ action: "close", space: "e2e-space", spaceId: 7, listed: true, ownership: "user" });
	assert.equal(out.ok, false);
	assert.match(out.error, /still listed/);
	assert.equal(typeof out.hint, "string");
});

test("finish keep:true with the space user-owned is a verified success", () => {
	const out = decideEndedTaskOutcome({
		action: "finish",
		space: "e2e-space",
		spaceId: 7,
		listed: true,
		ownership: "user",
		wantsClosed: false,
		keepHint: ["p1"]
	});
	assert.equal(out.ok, true);
	assert.equal(out.finished, true);
	assert.equal(out.ownership, "user");
	assert.equal(out.receipt, null);
	assert.equal(out.verifiedBy, "listTaskSpaces");
	// 0.1.10: the fallback echoes the request that produced the state.
	assert.deepEqual(out.keep, ["p1"]);
	// ...and says plainly that kept pages cannot be verified from the space list.
	assert.match(out.note, /page-level retention/);
});

test("finish keep:false with the space still listed is a failure (it wanted the space gone)", () => {
	const out = decideEndedTaskOutcome({ action: "finish", space: "e2e-space", spaceId: 7, listed: true, ownership: "user", wantsClosed: true, keepHint: [] });
	assert.equal(out.ok, false);
	assert.match(out.error, /wanted the space closed|still listed/);
	assert.equal(typeof out.hint, "string");
});

test("finish with the space gone is a verified success", () => {
	const out = decideEndedTaskOutcome({ action: "finish", space: "e2e-space", spaceId: 7, listed: false, ownership: "closed", wantsClosed: true });
	assert.equal(out.ok, true);
	assert.equal(out.ownership, "closed");
	assert.equal(out.finished, true);
	assert.equal(out.verifiedBy, "listTaskSpaces");
});

test("handoff with the space gone is a failure (nothing left to hand off)", () => {
	const out = decideEndedTaskOutcome({ action: "handoff", space: "e2e-space", spaceId: 7, listed: false, ownership: "closed" });
	assert.equal(out.ok, false);
	assert.match(out.error, /nothing left to act on/);
	assert.equal(typeof out.hint, "string");
});

test("handoff whose target state is already observed is a verified success", () => {
	// The space is listed and already delegated to the user: exactly what handoff
	// promises. 0.1.9 S2: this used to be reported as a failure.
	const out = decideEndedTaskOutcome({ action: "handoff", space: "e2e-space", spaceId: 7, listed: true, ownership: "agentDelegatedToUser" });
	assert.equal(out.ok, true);
	assert.equal(out.handedOff, true);
	assert.equal(out.ownership, "agentDelegatedToUser");
	assert.equal(out.verifiedBy, "listTaskSpaces");
	assert.equal(out.receipt, null);
});

test("takeover whose target state is already observed is a verified success", () => {
	const out = decideEndedTaskOutcome({
		action: "takeover",
		space: "e2e-space",
		spaceId: 7,
		listed: true,
		ownership: "agent",
		nameHint: "e2e-space"
	});
	assert.equal(out.ok, true);
	assert.equal(out.tookOver, true);
	assert.equal(out.ownership, "agent");
	assert.equal(out.verifiedBy, "listTaskSpaces");
	assert.equal(out.receipt, null);
	// 0.1.10: the name-addressed fallback reports the name it acted on.
	assert.equal(out.name, "e2e-space");
});

test("wait_control whose target state is already observed is a verified success", () => {
	const out = decideEndedTaskOutcome({
		action: "wait_control",
		space: "e2e-space",
		spaceId: 7,
		listed: true,
		ownership: "agent",
		requestedTimeoutMs: 1500,
		timeoutMs: 1500,
		clamped: false
	});
	assert.equal(out.ok, true);
	assert.equal(out.control, true);
	assert.equal(out.ownership, "agent");
	assert.equal(out.verifiedBy, "listTaskSpaces");
	assert.equal(out.receipt, null);
	// 0.1.10: a fallback result must not lose the budget fields the normal path reports.
	assert.equal(out.requestedTimeoutMs, 1500);
	assert.equal(out.timeoutMs, 1500);
	assert.equal(out.clamped, false);
	assert.equal(out.value, true);
});

test("complete with the space now user-owned is a verified success", () => {
	const out = decideEndedTaskOutcome({ action: "complete", space: "e2e-space", spaceId: 7, listed: true, ownership: "user" });
	assert.equal(out.ok, true);
	assert.equal(out.completed, true);
	assert.equal(out.ownership, "user");
	assert.equal(out.verifiedBy, "listTaskSpaces");
});

test("mark_error with the space now user-owned is a verified success", () => {
	const out = decideEndedTaskOutcome({ action: "mark_error", space: "e2e-space", spaceId: 7, listed: true, ownership: "user" });
	assert.equal(out.ok, true);
	assert.equal(out.markedError, true);
	assert.equal(out.ownership, "user");
	assert.equal(out.verifiedBy, "listTaskSpaces");
});

test("mark_error with the space gone is a verified success", () => {
	const out = decideEndedTaskOutcome({ action: "mark_error", space: "e2e-space", spaceId: 7, listed: false, ownership: "closed" });
	assert.equal(out.ok, true);
	assert.equal(out.markedError, true);
	assert.equal(out.ownership, "closed");
	assert.equal(out.verifiedBy, "listTaskSpaces");
});

test("wait_control with the space gone is a failure", () => {
	const out = decideEndedTaskOutcome({ action: "wait_control", space: "e2e-space", spaceId: 7, listed: false, ownership: "closed" });
	assert.equal(out.ok, false);
	assert.match(out.error, /nothing left to act on/);
	assert.equal(typeof out.hint, "string");
});

test("complete with the space still agent-owned is a failure with a next step", () => {
	const out = decideEndedTaskOutcome({ action: "complete", space: "e2e-space", spaceId: 7, listed: true, ownership: "agent" });
	assert.equal(out.ok, false);
	assert.equal(typeof out.hint, "string");
	assert.match(out.error, /still listed/);
});

test("a null spaceId falls back to the numeric space argument", () => {
	const out = decideEndedTaskOutcome({ action: "close", space: 42, spaceId: null, listed: false, ownership: "closed" });
	assert.equal(out.ok, true);
	assert.equal(out.spaceId, 42);
});

test("a null spaceId with a name stays null (no numeric fallback)", () => {
	const out = decideEndedTaskOutcome({ action: "close", space: "e2e-space", spaceId: null, listed: false, ownership: "closed" });
	assert.equal(out.ok, true);
	assert.equal(out.spaceId, null);
});
