/**
 * Unit tests for isFunctionSource — the 0.1.11 function-source detector used by
 * `ego_app_wait{for:"function"}` and `ego_app_js{mode:"auto"}`.
 *
 * Both callers must wrap only a WHOLE function source in `(...)`. Wrapping one in
 * `() => (...)` makes the arrow itself the value, so a wait on `() => false`
 * passes instantly and an evaluation of `() => 1+1` returns a function (which
 * JSON silently drops → `value` disappears).
 *
 * A shape test alone is not enough: `function".length` starts with `function`
 * but is an expression, so the source must also parse as a function expression.
 * Detection only compiles — the body is never executed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isFunctionSource } from "../lib/index.js";

test("whole function sources are detected", () => {
	const cases = [
		"() => false",
		"() => 1+1",
		"(a, b) => a + b",
		"async () => {}",
		"function () { return 1; }",
		"async function f() { return 1; }",
		"x => x * 2",
		"() => { throw new Error('never executed'); };"
	];
	for (const source of cases) assert.equal(isFunctionSource(source), true, source);
});

test("expressions that merely look like functions are rejected", () => {
	const cases = [
		'function".length', // N9: the original bug — starts with `function`, is an expression
		"x > 1",
		"const x = 1; return x;",
		"1 + 1",
		"null",
		"() =>",
		"( => 1"
	];
	for (const source of cases) assert.equal(isFunctionSource(source), false, source);
});

test("empty and non-string values are not function sources", () => {
	for (const value of ["", "   ", undefined, null, 42, {}, [], true]) {
		assert.equal(isFunctionSource(value), false, JSON.stringify(value) ?? String(value));
	}
});

test("detection only parses the source; it never runs the body", () => {
	globalThis.__dshFunctionSourceExecuted = undefined;
	assert.equal(isFunctionSource("() => { globalThis.__dshFunctionSourceExecuted = true; }"), true);
	assert.equal(globalThis.__dshFunctionSourceExecuted, undefined);
	delete globalThis.__dshFunctionSourceExecuted;
});

test("call expressions are not function sources (R3)", () => {
	// A call whose callee is a function expression is an expression: evaluating it
	// returns the call's value, not a function. 0.1.12 stops treating it as one.
	for (const source of ["(async () => 1)()", "(0, () => 7)()", "(() => 1)()", "(function () { return 1; })()"]) {
		assert.equal(isFunctionSource(source), false, source);
	}
	// The function sources themselves stay detected.
	for (const source of ["() => 1", "(a, b) => a", "function () { return 1; }", "async () => 1"]) {
		assert.equal(isFunctionSource(source), true, source);
	}
});
