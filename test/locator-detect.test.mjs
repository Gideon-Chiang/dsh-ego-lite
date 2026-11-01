/**
 * Unit tests for plainCssFrom(selector) — the N11 locator-vs-CSS discriminator.
 *
 * The bug this locks down: ego_app_pointer's mouse_click silently downgraded any
 * selector it did not recognise to `document.querySelector`, so ego locator
 * syntax (`@1`, `ref=`, `loc=`, `xpath=`, `text=`, `>> nth=`, suffix
 * `:has-text(...)` / `:text-is(...)` / `:text(...)`) either clicked (0,0) or died
 * with an engine error. 0.1.9 adds one shared predicate:
 *   plain CSS or `css=<css>` -> the CSS string (one `css=` prefix removed)
 *   anything carrying ego locator syntax -> null
 */
import assert from "node:assert/strict";
import test from "node:test";
import { plainCssFrom } from "../lib/index.js";

test("plain CSS selectors pass through unchanged", () => {
	const cases = [
		"#ctx",
		"button.save",
		"div > a[href='x']",
		'input[type="file"]',
		"section:not(.hidden) > p"
	];
	for (const selector of cases) assert.equal(plainCssFrom(selector), selector, selector);
});

test("one css= prefix is stripped", () => {
	const cases = [
		["css=#ctx", "#ctx"],
		["css=button:not(.x)", "button:not(.x)"],
		["css=div > a[href='x']", "div > a[href='x']"],
		["css=input[type='file']", "input[type='file']"]
	];
	for (const [input, expected] of cases) assert.equal(plainCssFrom(input), expected, input);
});

test("ego locator syntax is rejected", () => {
	const cases = [
		"@12",
		"ref=12",
		"loc=css:#ctx",
		"xpath=//button",
		"text=click target",
		// The suffix forms are the ones 0.1.8 missed: only a leading :has-text( was blocked.
		'button:has-text("click target")',
		"button:has-text(click target)",
		':text-is("click target")',
		'button:text("click target")',
		"div >> nth=0",
		"css=@1"
	];
	for (const selector of cases) assert.equal(plainCssFrom(selector), null, selector);
});

test("a css= prefix does not whitelist a locator", () => {
	assert.equal(plainCssFrom('css=button:has-text("Save")'), null);
	assert.equal(plainCssFrom("css=text=hello"), null);
});

test("quoted literals are CSS text, not ego locator syntax", () => {
	// 0.1.10: markers inside quotes must not cause a false "not plain CSS".
	const cases = [
		'[data-x="a>>b"]',
		'[title=":has-text("]',
		"a[href='x?ref=y']",
		'input[placeholder="text="]'
	];
	for (const selector of cases) assert.equal(plainCssFrom(selector), selector, selector);
	// css= is stripped first, then the quoted body is still just CSS text.
	assert.equal(plainCssFrom('css=[data-x="a>>b"]'), '[data-x="a>>b"]');
	// A marker outside the quotes is still a locator.
	assert.equal(plainCssFrom('div[data-x="a>>b"] >> nth=0'), null);
	assert.equal(plainCssFrom('button:has-text("a>>b")'), null);
});

test("an unclosed quoted value is still plain CSS (conservative)", () => {
	// No closing quote: the `>>` sits inside the quoted run, so it is not a
	// locator marker. 0.1.11 locks this conservative reading (don't guess locators).
	assert.equal(plainCssFrom('[data-x="a>>b]'), '[data-x="a>>b]');
});
