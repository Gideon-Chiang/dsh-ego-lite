/**
 * Unit tests for createOutputCollector(limitBytes) — the bounded output buffer
 * behind runScript/ego_app_run.
 *
 * The bug this locks down: 0.1.8 bounded output by `String.length` (UTF-16 code
 * units), so 120 KB of CJK text (360 KB of UTF-8) slipped past a 64 KB
 * maxOutputBytes budget. The contract: the limit counts UTF-8 bytes, `truncated`
 * reports that bytes were dropped, and `value` decodes the kept bytes correctly
 * even when a multibyte character is split across two stream chunks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createOutputCollector } from "../lib/index.js";

// The 0.1.9 contract called the decoded field `value`; the shipped lib exposes
// it as `text`. Accept either name (and a getter or a plain method) so the tests
// measure the accounting semantics, not accessor spelling.
const valueOf = (collector) => {
	const raw = collector.text ?? collector.value;
	return typeof raw === "function" ? raw.call(collector) : raw;
};
const truncatedOf = (collector) => (typeof collector.truncated === "function" ? collector.truncated() : collector.truncated);

test("keeps output below the byte limit intact and un-truncated", () => {
	const collector = createOutputCollector(64);
	collector.push(Buffer.from("hello "));
	collector.push(Buffer.from("world"));
	assert.equal(valueOf(collector), "hello world");
	assert.equal(truncatedOf(collector), false);
});

test("output exactly at the byte limit is not truncation", () => {
	const collector = createOutputCollector(10);
	collector.push(Buffer.from("0123456789"));
	assert.equal(valueOf(collector), "0123456789");
	assert.equal(truncatedOf(collector), false);
});

test("an empty collector starts empty", () => {
	const collector = createOutputCollector(8);
	assert.equal(valueOf(collector), "");
	assert.equal(truncatedOf(collector), false);
});

test("the limit counts UTF-8 bytes, not UTF-16 code units", () => {
	// Ten CJK characters are 30 UTF-8 bytes but only 10 JavaScript string units.
	// A UTF-16-based counter (0.1.8's `String.length`) would not truncate at 21.
	const text = "中".repeat(10);
	const collector = createOutputCollector(21); // exactly 7 CJK characters
	collector.push(Buffer.from(text, "utf8"));
	assert.equal(
		truncatedOf(collector),
		true,
		"30 UTF-8 bytes exceed a 21-byte limit even though the text has only 10 UTF-16 code units"
	);
	const kept = valueOf(collector);
	assert.ok(
		Buffer.byteLength(kept, "utf8") <= 21,
		`kept output must respect the byte limit, got ${Buffer.byteLength(kept, "utf8")} bytes`
	);
	assert.ok(
		text.startsWith(kept),
		`decoded value must be a character prefix of the input, got ${JSON.stringify(kept)}`
	);
});

test("a multibyte character split across chunks is decoded correctly", () => {
	const collector = createOutputCollector(64);
	const buffer = Buffer.from("中文ab", "utf8");
	collector.push(buffer.subarray(0, 4)); // ends inside the second character (文)
	collector.push(buffer.subarray(4));
	assert.equal(valueOf(collector), "中文ab");
	assert.equal(truncatedOf(collector), false);
});

test("bytes after the limit are dropped without changing the kept value", () => {
	const collector = createOutputCollector(4);
	collector.push(Buffer.from("abcd"));
	assert.equal(truncatedOf(collector), false);
	collector.push(Buffer.from("efgh"));
	assert.equal(truncatedOf(collector), true);
	assert.equal(valueOf(collector), "abcd");
});
