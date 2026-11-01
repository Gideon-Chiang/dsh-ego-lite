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

test("N4: nested default parameters are still function sources", () => {
	const cases = [
		["(x = foo()) => x > 0", true],
		["(a = (1)) => a", true],
		["((a) => a)", false],
		["(async () => 1)()", false]
	];
	for (const [source, expected] of cases) assert.equal(isFunctionSource(source), expected, source);
});

test("N4: regex literals and division are not mistaken for brackets", () => {
	const cases = [
		["(x) => /\\)/.test(x)", true],
		["(s) => /\\d+/.test(s)", true],
		["(x) => x.replace(/\\)/g, \"\")", true],
		["(a) => a / 2", true],
		["(a) => (1) / 2", true],
		["(a) => a++ / 2", true],
		["(a) => /unterminated", false]
	];
	for (const [source, expected] of cases) assert.equal(isFunctionSource(source), expected, source);
});

test("N4-a: comments in a function body are skipped", () => {
	const cases = [
		["(x) => { // note\n return x; }", true],
		["(x) => { /* } */ return x; }", true],
		["(x) => x /* ) */ > 0", true],
		["(x) => { /* unterminated }", false]
	];
	for (const [source, expected] of cases) assert.equal(isFunctionSource(source), expected, source);
});

test("N4-b: regex literals after keywords are skipped", () => {
	const cases = [
		["(x) => { return /}/.test(x); }", true],
		["(x) => typeof /}/.test(x)", true],
		["(x) => { return /\\)/.test(x); }", true],
		["(x) => { const r = /[)]/; return r.test(x); }", true]
	];
	for (const [source, expected] of cases) assert.equal(isFunctionSource(source), expected, source);
});

test("N4: strings, templates and division are not misread as comments or regex", () => {
	const cases = [
		["(x) => x === \"})//\"", true],
		["(x) => `${x} ) } //`", true],
		["(a) => a / 2", true],
		["(a) => a++ / 2", true],
		["(x = 1) => { /* keep */ return x > 0; }", true],
		["(async () => 1)()", false],
		["(0, () => 7)()", false],
		["function(){}()", false],
		["((a) => a)", false]
	];
	for (const [source, expected] of cases) assert.equal(isFunctionSource(source), expected, source);
});

test("N4-a: a comment between return and a regex keeps function-source detection", () => {
	assert.equal(isFunctionSource("(x) => { return /*c*/ /}/.test(x); }"), true, "(x) => { return /*c*/ /}/.test(x); }");
});

test("N4-a: a comment before a regex default parameter keeps function-source detection", () => {
	assert.equal(isFunctionSource("(a = /*c*/ /[)]/.test(\")\")) => a"), true, "(a = /*c*/ /[)]/.test(\")\")) => a");
});

test("N4-a: a comment before a regex in an expression body keeps function-source detection", () => {
	assert.equal(isFunctionSource("(a) => a + /*c*/ /[)]/.test(a)"), true, "(a) => a + /*c*/ /[)]/.test(a)");
});

test("N4-a: a header comment in a function declaration keeps function-source detection", () => {
	assert.equal(isFunctionSource("function /*c*/ f(){}"), true, "function /*c*/ f(){}");
});

test("N4-a: a header comment in an async arrow keeps function-source detection", () => {
	assert.equal(isFunctionSource("async /*c*/ () => 1"), true, "async /*c*/ () => 1");
});

test("N4-a: a header comment in a generator keeps function-source detection", () => {
	assert.equal(isFunctionSource("function* /*c*/ g(){}"), true, "function* /*c*/ g(){}");
});

test("N4-a: a comment between function and its generator star keeps detection", () => {
	assert.equal(isFunctionSource("function /*c*/ * g() {}"), true, "function /*c*/ * g() {}");
});

test("N4-a: a comment between async, function and the generator star keeps detection (false cases unchanged)", () => {
	assert.equal(isFunctionSource("async /*c*/ function /*c*/ * g() {}"), true, "async /*c*/ function /*c*/ * g() {}");
	// The call/sequence/parenthesised-arrow forms must stay expression sources.
	for (const source of ["function(){}()", "(async () => 1)()", "(0, () => 7)()", "((a) => a)"]) {
		assert.equal(isFunctionSource(source), false, source);
	}
});
