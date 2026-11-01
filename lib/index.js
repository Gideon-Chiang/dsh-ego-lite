/**
 * dsh-ego-lite — full coverage of the ego lite agent control surface.
 *
 * Every call spawns the official CLI (`ego-browser nodejs`), which talks to the
 * running ego lite application over its own IPC: each task runs inside a real
 * ego TaskSpace (visible in the app's Space panel) with the app's real profile
 * and logins. No CDP, no separate Chromium.
 *
 * Coverage (all verified against ego lite 0.6.2.5 / Chromium 156):
 *   app level  ego.getBrowserVersion / listTaskSpaces / createTaskSpace /
 *              claimTaskSpace / useTaskSpace / closeTaskSpace / deleteSpaces /
 *              handOffTaskSpace / takeOverTaskSpace / completeTaskSpace /
 *              markTaskSpaceError / setAgentTaskState / listTabs / createTab /
 *              listProfiles / showAgentGesture / highlightMouse / sendCDPMessage
 *   space      page / userPage / pages / tabs / newPage / adopt / release /
 *              waitForControl / handOff / finish / cdp
 *   page       goto / reload / url / title / info / snapshot / screenshot /
 *              waitForSelector / waitForURL / waitForLoadState / waitForFunction /
 *              waitForTimeout / waitForEvent / evaluate / fetch / cdp / click /
 *              dblclick / hover / dragAndDrop / fill / selectOption / focus /
 *              press / setInputFiles / waitForFileChooser / acceptDialog /
 *              dismissDialog / events / mouse / keyboard / close
 *
 * Script text is written to a UTF-8 .mjs and entered through the documented
 * `-e "await import('file:///…')"` form, so Chinese text and multi-line scripts
 * never pass through shell quoting.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "ego-lite";
export const inject = ["tools", "systemPrompt"];

const SENTINEL = "@@DSH_RESULT@@";
/**
 * Nonce placeholder printed inside plugin-generated scripts and replaced per run.
 * A page line echoing `@@DSH_RESULT@@` cannot guess the token, so it can no longer
 * spoof a structured tool's result (ego_app_run keeps the plain sentinel because
 * user scripts print it themselves).
 */
const NONCE_SLOT = "@@DSH_NONCE_SLOT@@";
/** Newline used when composing generated scripts (readable in stack traces). */
const NL = String.fromCharCode(10);
const INSTALL_ROOT = "C:\\Program Files\\Citro Labs\\ego lite\\Application";

const OUT = {
	schema: { type: "object", additionalProperties: true },
	render: (_args, value) => {
		const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
		const limit = 20000;
		if (text.length <= limit) return [{ type: "text", text }];
		return [{ type: "text", text: `${text.slice(0, limit)}
…[renderedTruncated omittedChars=${text.length - limit} limitChars=${limit}]` }];
	}
};

export const Config = z.object({
	executable: z.string().default("auto"),
	timeoutMs: z.number().step(1).min(5000).default(180000),
	maxOutputBytes: z.number().step(1).min(65536).default(1048576),
	announceToAgent: z.boolean().default(true)
});

/** Resolve the official ego-browser CLI: config value, install scan, then PATH. */
function resolveExecutable(config) {
	const configured = String(config?.executable ?? "auto").trim();
	if (configured !== "" && configured !== "auto") return configured;
	if (process.env.EGO_BROWSER_CLI) return process.env.EGO_BROWSER_CLI;
	try {
		const versions = readdirSync(INSTALL_ROOT, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
			.reverse();
		for (const version of versions) {
			const candidate = path.join(INSTALL_ROOT, version, "ego-browser.exe");
			if (existsSync(candidate)) return candidate;
		}
	} catch {}
	return process.platform === "win32" ? "ego-browser.exe" : "ego-browser";
}

function killTree(pid) {
	if (!pid) return;
	try {
		if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		else process.kill(-pid, "SIGKILL");
	} catch {}
}

/**
 * Collect one CLI stream while enforcing `maxOutputBytes` in UTF-8 **bytes**.
 * The limit used to be compared against `String.length` (UTF-16 code units), so
 * Chinese output travelled ~3x past the configured byte budget before the flag
 * tripped. Exported so the accounting is unit-testable without the app.
 */
export function createOutputCollector(limitBytes) {
	const limit = Math.max(0, Number(limitBytes) || 0);
	const chunks = [];
	let bytes = 0;
	let truncated = false;
	return {
		push(chunk) {
			if (truncated) return;
			const room = limit - bytes;
			if (chunk.length > room) {
				truncated = true;
				if (room > 0) {
					chunks.push(chunk.subarray(0, room));
					bytes += room;
				}
				return;
			}
			chunks.push(chunk);
			bytes += chunk.length;
		},
		get truncated() { return truncated; },
		get bytes() { return bytes; },
		get text() { return Buffer.concat(chunks).toString("utf8"); }
	};
}

/** Run one script through the official CLI and parse the sentinel result. */
function runScript(config, script, options = {}) {
	const signal = options.signal;
	if (signal && signal.aborted) return Promise.resolve({ ok: false, error: "aborted by the caller" });
	// One nonce per run: plugin-generated scripts carry the placeholder, user
	// scripts (ego_app_run) do not, so they keep the plain sentinel.
	let sentinelToken = "";
	let scriptText = script;
	// Match the whole printed expression, not the bare slot marker: user data that
	// happens to contain the marker is left exactly as written.
	const nonceSlotExpression = `${JSON.stringify(SENTINEL)} + ${JSON.stringify(NONCE_SLOT)}`;
	const nonceAt = scriptText.lastIndexOf(nonceSlotExpression);
	if (nonceAt >= 0) {
		sentinelToken = randomBytes(8).toString("hex");
		const replacement = `${JSON.stringify(SENTINEL)} + ${JSON.stringify(sentinelToken)}`;
		scriptText = scriptText.slice(0, nonceAt) + replacement + scriptText.slice(nonceAt + nonceSlotExpression.length);
	}
	const executable = resolveExecutable(config);
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-ego-"));
	const file = path.join(dir, "task.mjs");
	writeFileSync(file, scriptText, { encoding: "utf8" });
	const entry = `await import(${JSON.stringify(pathToFileURL(file).href)})`;
	const limit = config.maxOutputBytes ?? 1048576;
	const stdoutCollector = createOutputCollector(limit);
	const stderrCollector = createOutputCollector(limit);

	return new Promise((resolve) => {
		let settled = false;
		let timer;
		let child;
		let abortListener = null;
		const finish = (payload) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (abortListener && signal) { try { signal.removeEventListener("abort", abortListener); } catch {} }
			try { rmSync(dir, { recursive: true, force: true }); } catch {}
			resolve(payload);
		};
		try {
			child = spawn(executable, ["nodejs", "-e", entry], {
				cwd: process.cwd(),
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"]
			});
		} catch (error) {
			return finish({ ok: false, error: `cannot start ${executable}: ${error instanceof Error ? error.message : String(error)}` });
		}
		timer = setTimeout(() => {
			killTree(child.pid);
			finish({ ok: false, error: `ego-browser timed out after ${config.timeoutMs ?? 180000} ms` });
		}, config.timeoutMs ?? 180000);
		if (signal) {
			abortListener = () => {
				killTree(child.pid);
				finish({ ok: false, error: "aborted by the caller" });
			};
			if (signal.aborted) abortListener();
			else signal.addEventListener("abort", abortListener, { once: true });
		}

		child.stdout.on("data", (chunk) => stdoutCollector.push(chunk));
		child.stderr.on("data", (chunk) => stderrCollector.push(chunk));
		child.on("error", (error) => finish({ ok: false, error: `${executable}: ${error.message}` }));
		child.on("close", (code) => {
			// The ego runtime routes console.log to stderr, so the sentinel may arrive
			// on either stream; interpretCliOutcome handles both and the failure modes.
			finish(interpretCliOutcome({
				code,
				stdout: stdoutCollector.text,
				stderr: stderrCollector.text,
				allowPlainText: options.allowPlainText === true,
				truncated: stdoutCollector.truncated || stderrCollector.truncated,
				token: sentinelToken
			}));
		});
	});
}

/** Drop undefined-valued keys (recursively) so tool results stay lossless JSON. */
const lossless = (value, depth = 0) => {
	if (depth > 64) return value === undefined ? null : value;
	if (Array.isArray(value)) return value.map((item) => lossless(item, depth + 1));
	if (value === null || typeof value !== "object") return value;
	const out = {};
	for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = lossless(item, depth + 1);
	return out;
};
const j = (value) => JSON.stringify(value);
/** A caller-supplied timeout must be a positive finite number of milliseconds. */
const TIMEOUT_ERROR = "timeoutMs must be a positive number of milliseconds (it is a duration, not a flag).";
const badTimeout = (value) => value !== undefined && value !== null && !(Number.isFinite(Number(value)) && Number(value) > 0);
const print = (expression) => `console.log(${JSON.stringify(SENTINEL)} + ${JSON.stringify(NONCE_SLOT)} + JSON.stringify(${expression}));`;

/**
 * Official preflight messages: ego lite prints these as plain text and exits 0,
 * without running the script, so no sentinel is produced. Treating that as
 * success is what made `ego_app_status` answer `{ok:true, data:null}` before the
 * app had finished onboarding. (Onboarding is a GUI step that registers the
 * CLI/IPC bridge — see the ego-browser skill, references/install.md.)
 */
const CLI_PREFLIGHT = [{
	pattern: /please complete the onboarding process|onboarding process first/i,
	error: "ego lite onboarding is not complete, so the ego-browser CLI refused to run the script (it printed that notice and exited 0).",
	hint: "Finish the in-app onboarding — the welcome window that opens on first launch; every step can be skipped — then retry. Onboarding is what wires up the CLI/IPC bridge."
}];

/**
 * Map one finished CLI run to the tool result. Pure, so it can be unit-tested
 * against real CLI output without launching the app.
 */
export function interpretCliOutcome({ code, stdout = "", stderr = "", allowPlainText = false, truncated = false, token = "" }) {
	const rows = [...stdout.split(/\r?\n/), ...stderr.split(/\r?\n/)];
	// A structured run carries a per-run token after the sentinel; a page cannot
	// guess it, so an echoed lookalike is not accepted. ego_app_run has no token
	// and keeps the documented plain `@@DSH_RESULT@@` contract.
	const marker = SENTINEL + token;
	let sentinelLine;
	// Last match wins: the generated script prints the sentinel after every other
	// line, so an earlier lookalike echoed from the page cannot spoof the result.
	for (const row of rows) if (row.startsWith(marker)) sentinelLine = row;
	// Remove only the line that actually carried THIS run's result. A page can
	// echo a lookalike sentinel line, and that is exactly the kind of output a
	// caller needs to see when diagnosing a failure: dropping every line that
	// starts with the sentinel hid it from `log` (and from `output`).
	const clean = (text) => text.split(/\r?\n/)
		.filter((row) => !(token !== "" ? row.startsWith(marker) : row === sentinelLine))
		.join("\n").trim();
	const log = clean(stderr) || clean(stdout);
	const stderrText = clean(stderr);
	const truncationError = (detail) => ({
		ok: false,
		error: `CLI output exceeded maxOutputBytes, so ${detail}. Raise maxOutputBytes or print less (large snapshots are the usual cause).`,
		hint: "Increase the plugin's maxOutputBytes config, or narrow the call (snapshot scope, fewer fields).",
		output: log.slice(0, 2000),
		log,
		stderr: stderrText
	});
	if (sentinelLine) {
		try {
			// A sentinel that arrived whole still leaves `log` incomplete when the
			// output was cut afterwards; say so instead of looking complete.
			return { ok: true, result: JSON.parse(sentinelLine.slice(marker.length)), log, stderr: stderrText, ...(truncated ? { truncated: true } : {}) };
		} catch {
			if (truncated) return truncationError(`the ${SENTINEL} line was cut before it ended`);
			return { ok: false, error: `${SENTINEL} payload was not valid JSON: ${sentinelLine.slice(0, 500)}`, log, stderr: stderrText };
		}
	}
	// Diagnosis order matters. An incomplete journey (onboarding, non-zero exit)
	// must be reported as itself rather than as "output too large", and plain-text
	// `ego_app_run` output must survive truncation — it never needs a sentinel, so
	// size alone cannot make it a failure.
	const preflight = CLI_PREFLIGHT.find((entry) => entry.pattern.test(`${stdout}\n${stderr}`));
	if (preflight) return { ok: false, error: preflight.error, hint: preflight.hint, output: log.slice(0, 4000), log, stderr: stderrText };
	if (code !== 0) return { ok: false, error: (log || `ego-browser exited with code ${code}`).slice(0, 4000), log, stderr: stderrText };
	if (allowPlainText) return { ok: true, result: null, log, stderr: stderrText, ...(truncated ? { truncated: true } : {}) };
	if (truncated) return truncationError(`the ${SENTINEL} line never arrived intact`);
	if (token !== "") {
		return {
			ok: false,
			error: `ego-browser exited 0 without a result line carrying this run's sentinel token (${SENTINEL}<token>), so this call's result could not be confirmed. The script may have ended early or its output may have been replaced; a bare ${SENTINEL} line is not accepted as this call's result. CLI output: ${log.slice(0, 2000) || "(empty)"}`,
			hint: "Retry the call; if it repeats, check maxOutputBytes and that no wrapper strips the runner's sentinel line.",
			log,
			stderr: stderrText
		};
	}
	return {
		ok: false,
		error: `ego-browser exited 0 without printing ${SENTINEL}, so the script never ran. CLI output: ${log.slice(0, 2000) || "(empty)"}`,
		hint: "Check that ego lite is installed, running, and past onboarding; set EGO_BROWSER_CLI (or the executable config) if the CLI lives elsewhere.",
		log,
		stderr: stderrText
	};
}

/**
 * Generated-script helpers: describe an unreadable IPC answer without throwing
 * from the description itself (circular/getter values would make
 * JSON.stringify throw and hide the real diagnosis), and read the TaskSpace list
 * or throw a readable error. A failed read must never be mistaken for "no
 * spaces": every caller that treats an empty list as "the space is gone" would
 * otherwise turn a broken bridge into a success or a wrong "no such space"
 * diagnosis.
 */
const describeReadHelper = `const describeRead = (value) => {
  try {
    if (value === null || value === undefined || typeof value !== "object") return String(value).slice(0, 300);
    const text = JSON.stringify(value);
    return (text === undefined ? String(value) : text).slice(0, 300);
  } catch {
    try { return String(value).slice(0, 300); } catch { return "(unprintable)"; }
  }
};
`;
const readSpacesHelper = `${describeReadHelper}const readTaskSpaces = async (what) => {
  const listed = await ego.listTaskSpaces();
  if (!listed || !Array.isArray(listed.taskSpaces)) {
    throw new Error("ego.listTaskSpaces() returned an error instead of its TaskSpace list" + (what ? " (while " + what + ")" : "") + ": " + describeRead(listed) + " — the space list is unreadable, so the outcome cannot be verified");
  }
  return listed.taskSpaces;
};
/** Same contract for the app-level tab list: an error object is not "no tabs". */
const readTabsList = (listed, what) => {
  if (!listed || !Array.isArray(listed.tabs)) {
    throw new Error("ego.listTabs() returned an error instead of its tab list" + (what ? " (" + what + ")" : "") + ": " + describeRead(listed) + " — the app tab list is unreadable, so this call cannot report tabs");
  }
  return listed.tabs;
};
`;

/**
 * Resolve an EXISTING TaskSpace: by name, by id, or (when omitted) the newest
 * space this agent owns — including one currently delegated to the user, so
 * `handoff` → `wait_control`/`takeover` works without repeating the name.
 *
 * `taskSpace(name)` is officially "reuse **or create**", so a bare
 * `taskSpace(name)` silently creates a space when the name is unknown. That is
 * how a retried `close` used to become "create a same-named space, close it,
 * report ok:true". Resolve through listTaskSpaces() and resume by id instead:
 * every action below except `open` can then only ever touch an existing space.
 */
const spacePrelude = (space) => `${readSpacesHelper}const __spaceWanted = ${j(space ?? "")};
const __spaceAll = await readTaskSpaces("resolving the target space");
const __spaceIsId = typeof __spaceWanted === "number" || /^\\d+$/.test(String(__spaceWanted));
const __spaceRow = __spaceWanted === ""
  ? (__spaceAll.slice().reverse().find((s) => s.ownership === "agent") ?? __spaceAll.slice().reverse().find((s) => s.ownership === "agentDelegatedToUser"))
  : __spaceIsId
    ? __spaceAll.find((s) => s.id === Number(__spaceWanted))
    : __spaceAll.find((s) => s.name === __spaceWanted);
if (!__spaceRow) throw new Error(__spaceWanted === ""
  ? 'no agent TaskSpace is open; call ego_app_space{action:"open", name} first (or pass name)'
  : 'no TaskSpace ' + (__spaceIsId ? 'with id ' + __spaceWanted : 'named "' + __spaceWanted + '"') + ' is currently open. This action only operates on an existing space; it never creates one.');
const task = await taskSpace(__spaceRow.id);
`;

/**
 * `open` is the one action allowed to create: official `taskSpace(name)` is
 * reuse-or-create, which is exactly the documented "open (resume or create)".
 */
const spaceOpenPrelude = (space) => `const __openTarget = ${j(space ?? "")};
const task = await taskSpace(__openTarget === "" ? "" : (typeof __openTarget === "number" ? __openTarget : (/^\\d+$/.test(String(__openTarget)) ? Number(__openTarget) : __openTarget)));
`;

const pagePrelude = (label) => `const wantedLabel = ${j(label ?? "p1")};
const knownPages = (await task.pages()).map((p) => p.label);
const __pageCreated = !knownPages.includes(wantedLabel);
const page = __pageCreated ? await task.newPage() : task.page(wantedLabel);
`;

/**
 * Official action receipts carry the immediately observed popups and dialogs
 * (skill guide "Action receipts, popups, and dialogs"). Serialize them into
 * plain JSON so callers can see them without a second round trip.
 */
const receiptPrelude = `const describeReceipt = (receipt) => {
  if (!receipt || typeof receipt !== "object") return undefined;
  const out = {};
  if (Array.isArray(receipt.popups) && receipt.popups.length > 0) {
    out.popups = receipt.popups.map((entry) => ({ label: entry && entry.label, targetId: entry && entry.targetId }));
  }
  if (receipt.dialog) {
    const dialog = receipt.dialog;
    // Dialog text is page-controlled: keep it readable but bounded so a hostile
    // page cannot push megabytes through a receipt.
    const cap = (value) => {
      if (value === undefined || value === null) return null;
      const text = typeof value === "string" ? value : String(value);
      return text.length > 2000 ? text.slice(0, 2000) + "…[truncated " + (text.length - 2000) + " chars]" : text;
    };
    const read = (name) => {
      try {
        const value = dialog[name];
        if (typeof value === "function") return cap(value.call(dialog));
        return cap(value);
      } catch { return null; }
    };
    out.dialog = { type: read("type"), message: read("message"), defaultPrompt: read("defaultPrompt") };
  }
  return out;
};
`;

/**
 * ego locator syntax that `document.querySelector()` cannot parse. ego accepts
 * `@12` / `ref=` / `text=` / `loc=css|role|href:` / `xpath=` prefixes, a leading
 * `css=` prefix, `>> nth=N` chains, and the terminal Playwright pseudos
 * `:has-text(...)`, `:text-is(...)` and `:text(...)` — the pseudo may follow a
 * compound (`button:has-text("Save")`), not only start the string.
 */
const EGO_LOCATOR = /^(?:ref|loc|xpath|text|css)=|^@|>>|:has-text\(|:text-is\(|:text\(/;

/**
 * The plain-CSS form of a selector, or null when ego's own locator parser is
 * required. A single leading `css=` is stripped (ego documents `css=...` as
 * "the same raw CSS selector"), but any other locator feature yields null so no
 * caller ever feeds an ego locator to document.querySelector().
 */
export function plainCssFrom(selector) {
	const raw = typeof selector === "string" ? selector.trim() : "";
	if (raw === "") return null;
	const stripped = raw.startsWith("css=") ? raw.slice(4).trim() : raw;
	// Quoted values are literal CSS text: `[data-x="a>>b"]` or `[title=":has-text("]`
	// are legal CSS and must not be mistaken for ego locator syntax. A real locator
	// keeps its marker outside the quotes, so stripping quoted runs is safe.
	const unquoted = stripQuotedLiterals(stripped);
	if (stripped === "" || EGO_LOCATOR.test(unquoted)) return null;
	return stripped;
}

/**
 * Poll the app's TaskSpace list until a post-condition holds. ego refreshes that
 * list asynchronously: for ~25–50 ms after `closeTaskSpace()` the space is still
 * listed (with a transient ownership), so a single snapshot both reports false
 * failures and cannot prove success. Absence is reported as ownership "closed"
 * so every action can share one "the space no longer exists" vocabulary.
 */
const spaceWatch = `const waitSpaceState = async (spaceId, done, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let last = { listed: true, ownership: "unreadable", readFailed: true };
  for (;;) {
    const listed = await ego.listTaskSpaces();
    if (listed && Array.isArray(listed.taskSpaces)) {
      const row = listed.taskSpaces.find((s) => s.id === spaceId);
      last = row ? { listed: true, ownership: row.ownership, readFailed: false } : { listed: false, ownership: "closed", readFailed: false };
      if (done(last)) return last;
    } else {
      // A failed read must never look like "the space is gone": keep the reason.
      last = { listed: true, ownership: "unreadable", readFailed: true };
    }
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};
`;

/**
 * Lines that arm nothing but do the click: optional pre-scroll for a plain CSS
 * trigger, the click itself, and a scroll restore so a trigger far down the page
 * does not leave the viewport parked there (ego does not reliably scroll back
 * up, so a later click on a top element times out).
 *
 * `timeoutMs` is the budget for the whole call (trigger click + awaited event).
 * The click therefore gets whatever is left of it — not a second, independent
 * budget — while a small floor keeps an existing element clickable.
 */
const clickTriggerLines = (trigger, timeoutMs) => {
	if (!trigger) return "const receipt = null;" + NL;
	const cssTarget = plainCssFrom(trigger);
	const requested = Number(timeoutMs);
	const budget = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 30000;
	const capture = "const __scrollState = await page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return null; const state = []; let node = el; while (node && node.nodeType === 1) { const scrollable = node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth; if (scrollable) state.push([node, node.scrollTop, node.scrollLeft]); node = node.parentElement; } state.push([null, window.scrollY, window.scrollX]); window.__dshScrollState = state; return true; }, " + j(cssTarget) + ");";
	// scrollIntoView also scrolls overflow:auto ancestors, so restore every
	// scrollable ancestor, not just the document.
	const restore = 'if (!__clickError && !(receipt && receipt.dialog)) { await page.evaluate(() => { const state = window.__dshScrollState; if (!state) return; for (const row of state) { const node = row[0], top = row[1], left = row[2]; if (node) { node.scrollTop = top; node.scrollLeft = left; } else { window.scrollTo(left, top); } } delete window.__dshScrollState; }).catch(() => {}); }';
	const lines = [
		`const __budgetMs = ${budget};`,
		"const __budgetStart = Date.now();",
		cssTarget ? capture : null,
		cssTarget ? `await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: "center" }); return true; }, ${j(cssTarget)});` : null,
		"let receipt = null; let __clickError = null;",
		`try { receipt = await page.click(${j(trigger)}, { timeout: Math.max(500, __budgetMs - (Date.now() - __budgetStart)) }); } catch (e) { __clickError = e; }`,
		cssTarget ? restore : null,
		'if (__clickError) { var __ce = (__clickError && __clickError.message ? __clickError.message : String(__clickError)); var __cr = describeReceipt(receipt) ?? null; throw new Error(__ce + " | click receipt: " + JSON.stringify(__cr) + " | the trigger click itself failed; if it opened a chooser or dialog that an expired waiter could not receive, retry with a larger timeoutMs"); }',
	].filter(Boolean);
	return lines.join(NL) + NL;
};

/**
 * Error text for a waiter that never fired: always carries the click receipt and
 * says what to do next. Built before any cleanup so a hanging CDP call cannot
 * replace it with the plugin-level timeout.
 */
const waiterErrorExpr = (varName, what) =>
	`var __base = (${varName} && ${varName}.message ? ${varName}.message : String(${varName})); ` +
	`var __r = describeReceipt(receipt) ?? null; ` +
	`var __hint = __r && __r.dialog ? " | the click opened a dialog (" + __r.dialog.type + "): answer it with ego_app_dialog{action:'accept'} or {action:'dismiss'} and retry" : " | ${what}: retry; if it keeps failing, close or reload the Page"; ` +
	`var __err = new Error(__base + " | click receipt: " + JSON.stringify(__r) + __hint); ` +
	`try { await page.cdp("Page.setInterceptFileChooserDialog", { enabled: false }, { timeout: 3000 }); } catch {} ` +
	`throw __err;`;

/** Build a complete script: space prelude, optional page prelude, body, sentinel. */
function buildScript({ space, label, usePage = true, createSpace = false, body, result }) {
	const prelude = createSpace ? spaceOpenPrelude(space) : spacePrelude(space);
	// Capture the space id before the body runs: close/finish/complete/mark_error
	// (and handoff/takeover) end the agent's hold on the space, so reading
	// `task.spaceId` afterwards is reading a field the ending action may have
	// invalidated (audit N11 class). Bodies/results use `__spaceId` for that.
	const spaceIdLine = `const __spaceId = task.spaceId;${NL}`;
	// Page tools advertise `pageCreated` so a silent newPage() is visible to the
	// caller (space actions and gesture keep their exact result shape).
	const printed = usePage ? `Object.assign({ pageCreated: __pageCreated }, ${result})` : result;
	return `${prelude}${spaceIdLine}${usePage ? pagePrelude(label) + receiptPrelude : ""}${body}
${print(printed)}`;
}

/**
 * Next-step hint for failures that arrive as plain CLI text. Generated scripts
 * throw real Errors, and the exact state they observed is the only useful thing
 * to build on, so keep the hint derived from that text rather than a generic
 * "retry".
 */
function hintFor(error) {
	const text = String(error ?? "");
	if (/is currently open\. This action only operates on an existing space; it never creates one\./.test(text)) {
		return 'Call ego_app_space{action:"list"} to see the open TaskSpaces, or ego_app_space{action:"open", name} to create one. A space that was already closed stays closed — the action did not run, so re-checking the list is the next step, not a blind retry.';
	}
	if (/no agent TaskSpace is open/.test(text)) return 'Call ego_app_space{action:"open", name} first, then retry.';
	// Tab reads get their own hint: the generic "TaskSpace list" wording below
	// would send the caller to the wrong list (0.1.11 made tab reads fail closed
	// with the same "unreadable" word).
	if (/tab list is unreadable/.test(text)) {
		return 'The app would not list its tabs (ego.listTabs()/task.tabs() answered with an error). Select the TaskSpace first (ego_app_space{action:"use", id} or pass name), then retry; this failure is never reported as an empty tab list.';
	}
	if (/unreadable/.test(text)) return 'The app returned an error instead of its TaskSpace list, so the post-condition could not be checked. Run ego_app_space{action:"list"} (or ego_app_status) and retry; do not read this as success or as a completed transition.';
	if (/could not be read|could not be verified/.test(text)) return 'The post-condition could not be checked because the TaskSpace list could not be read from the app. Run ego_app_space{action:"list"} (or ego_app_status) and retry; this is neither proof that the action failed nor that it succeeded.';
	if (/no longer assigned to the agent|its task has ended|browser commands are paused/.test(text)) {
		return 'ego paused the agent task on this space (it was handed off or finished, or the space no longer exists). Run ego_app_space{action:"list"} to see the real ownership: if the space is gone there is nothing left to do, otherwise use wait_control/takeover with this space\'s name before retrying.';
	}
	if (/was still listed after/.test(text)) {
		return 'The app still lists this TaskSpace. Run ego_app_space{action:"list"} to confirm: if it shows ownership "user" or "agentDelegatedToUser", close it in the ego panel or ask the user to hand control back, then retry; if it is absent, the close did happen and nothing is left to do.';
	}
	if (/were still listed after/.test(text)) {
		return "deleteSpaces() did not remove every id it was given. Run ego_app_space{action:'list'} and retry delete with the ids that are still listed; an agent-owned (running) space must be closed or finished first.";
	}
	if (/no space with id|no space named/.test(text)) return 'Run ego_app_space{action:"list"} to see the current ids; a space removed by finish(keep:false) is already gone, so there may be nothing left to delete.';
	if (/only removes user-owned/.test(text)) return 'A space still held by the agent must be closed/finished first: ego_app_space{action:"close", name} or {action:"finish", name, keep:false}.';
	if (/matches [0-9]+ spaces/.test(text)) return 'Names are not guaranteed unique across spaces: pass explicit ids from ego_app_space{action:"list"}.';
	if (/EGO_TASK_SPACE_USER_IN_CONTROL|closeTaskSpace\(\) refused/.test(text)) {
		return 'Control of this TaskSpace is delegated to the user. Ask the user to hand it back (then ego_app_space{action:"wait_control"}), or close the space in the ego panel.';
	}
	if (/requires an untracked page|created by the agent; close it instead of releasing it/.test(text)) {
		return 'Only a tab the agent does not manage can be adopted/released — a Page this agent created must be closed with ego_app_page{action:"close"} (release refuses it). List the tabs of the space with ego_app_tabs{scope:"space"} (label/targetId/openedBy) or ego_app_space{action:"tabs"} first.';
	}
	if (/Page budget reached/i.test(text)) {
		return 'ego allows only 8 Pages per TaskSpace. Close the Pages this task no longer needs with ego_app_page{action:"close", page:"pN"}, or finish the space and open a new one.';
	}
	if (/did not hand control back|ownership is still|ownership is not|expected agentDelegatedToUser|so control is NOT with the agent/.test(text)) {
		return 'The app reports a state different from the action\'s promise. Run ego_app_space{action:"list"} and react to the observed ownership instead of assuming the action landed.';
	}
	return undefined;
}

/** Replace quoted literals with `""` so locator markers inside CSS strings are ignored. */
function stripQuotedLiterals(value) {
	let out = "";
	let quote = "";
	for (let index = 0; index < value.length; index += 1) {
		const ch = value[index];
		if (quote === "") {
			if (ch === '"' || ch === "'") { quote = ch; out += '""'; } else out += ch;
			continue;
		}
		if (ch === "\\") { index += 1; continue; }
		if (ch === quote) quote = "";
	}
	return out;
}

/**
 * Is this a whole function source (rather than a bare expression)? Both
 * `ego_app_wait{for:"function"}` and `ego_app_js{mode:"auto"}` must wrap only a
 * real function source in `(...)`; wrapping one in `() => (...)` makes the arrow
 * itself the value, so the wait passes at once and the evaluation yields a
 * function (which JSON silently drops).
 *
 * A shape test alone is not enough — `function".length` starts with `function`
 * but is an expression — so the source must also parse as a function
 * expression. `new Function` only compiles here; the body never runs.
 */
const FUNCTION_HEAD = /^\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/;
/** Trim + drop trailing semicolons: `() => 1;` is the same source as `() => 1`. */
const normalizeSource = (value) => String(value ?? "").trim().replace(/;+$/, "");
export function isFunctionSource(value) {
	if (typeof value !== "string") return false;
	const source = normalizeSource(value);
	if (source === "" || !FUNCTION_HEAD.test(source)) return false;
	try {
		new Function(`return (${source});`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Parse-only syntax check for the exact source a Page will receive. A typo in an
 * expression used to be spawned and then reported as a bare CLI `SyntaxError`
 * with no indication that nothing ran; checking the wrapped source first keeps
 * the failure local, readable, and side-effect free.
 */
function syntaxProblem(source) {
	try {
		new Function(`return (${source});`);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * Decide what an action means when ego reports "this task space is no longer
 * assigned to the agent / its task has ended / browser commands are paused"
 * instead of returning a result.
 *
 * ego can end the agent task as a *consequence* of the action itself
 * (close/finish/complete) and then hard-stops the script, discarding everything
 * it buffered — including our sentinel. Without this, a successful close was
 * reported as "the script never ran", i.e. exactly the class of false negative
 * 0.1.9 is meant to remove. The caller supplies an independent
 * `listTaskSpaces()` read, and this function only claims success when that
 * observation really matches the action's promise:
 *   - terminal actions (close/finish/complete/mark_error): success when the
 *     space is gone, or when it is now user-owned (the "hand it back" outcome);
 *   - handoff/wait_control/takeover: need a live space, so absence is failure.
 * Anything else keeps a failure, now with the observed state and a hint.
 * Exported and pure so the decision table is unit-testable without the app.
 */
export function decideEndedTaskOutcome({ action, space, listed, ownership, spaceId, wantsClosed = false, requestedTimeoutMs = null, timeoutMs = null, clamped = null, nameHint = null, keepHint = null }) {
	const target = spaceId ?? (typeof space === "number" ? space : null);
	const verified = "verified by an independent listTaskSpaces() read after ego ended the agent task and discarded the script output";
	const terminal = action === "close" || action === "finish" || action === "complete" || action === "mark_error";
	// handoff/takeover/wait_control are satisfied when the space already shows the
	// state they promise: the task ending mid-script does not make that untrue.
	const expectedOwnership = action === "handoff" ? "agentDelegatedToUser" : action === "wait_control" || action === "takeover" ? "agent" : null;
	if (expectedOwnership !== null && ownership === expectedOwnership) {
		const shape = action === "handoff" ? { handedOff: true } : action === "takeover" ? { tookOver: true } : { control: true };
		return { ok: true, spaceId: target, ...shape, ...actionExtras(), ownership, receipt: null, verifiedBy: "listTaskSpaces", note: `the TaskSpace already shows ownership "${ownership}", which is exactly what this action promises; ego ended the agent task before the script could report (${verified})` };
	}
	const shapeOf = () => action === "close" ? { closed: true } : action === "finish" ? { finished: true, keep: keepHint } : action === "complete" ? { completed: true } : { markedError: true };
	// The normal paths report these; a caller reading them must not get undefined
	// just because ego ended the task before the script could print.
	// Function declaration (hoisted): the target-state branch below calls it.
	function actionExtras() {
		return action === "takeover" ? { ...(nameHint === null ? {} : { name: nameHint }) }
			: action === "wait_control" ? { requestedTimeoutMs, timeoutMs, clamped, value: true }
				: {};
	}
	if (!listed) {
		if (terminal) {
			return { ok: true, spaceId: target, ...shapeOf(), ownership: "closed", receipt: null, verifiedBy: "listTaskSpaces", note: `ego ended the agent task while running this action and dropped the script output; the space is gone, so the action is done (${verified})` };
		}
		return {
			ok: false,
			error: `the TaskSpace is gone: ego ended the agent task and discarded the script output, so ${action === "handoff" ? "handOff()" : action === "takeover" ? "takeOverTaskSpace()" : "waitForControl()"} had nothing left to act on (${verified})`,
			hint: 'Call ego_app_space{action:"list"} to confirm. A handed-off or finished space cannot be resumed; open a new space if the goal continues.'
		};
	}
	if (action === "close") {
		return {
			ok: false,
			error: `closeTaskSpace() could not run: ego paused the agent task ("its task has ended") and space ${target ?? "(by name)"} is still listed with ownership "${ownership}"`,
			hint: 'A space whose agent task ended cannot be closed through the API — close it in the ego panel, or ask the user to hand control back and take it over with ego_app_space{action:"takeover"} before closing.'
		};
	}
	if (action === "finish" && wantsClosed) {
		return {
			ok: false,
			error: `finish({ keep: [] }) wanted the space closed, but the agent task ended and the space is still listed with ownership "${ownership}"`,
			hint: 'The TaskSpace is user-owned but still listed: delete it by id (ego_app_space{action:"delete", id}) if the Pages are no longer needed, or close it in the ego panel.'
		};
	}
	if (terminal && ownership === "user") {
		const keepCaveat = action === "finish" && wantsClosed === false ? "; page-level retention cannot be verified from the space list, so use the normal path receipt when keptManagedLabels matters" : "";
		return { ok: true, spaceId: target, ...shapeOf(), ownership: "user", receipt: null, verifiedBy: "listTaskSpaces", note: `ego ended the agent task before the script could report; the space is already user-owned, which is exactly what this action promises (${verified})${keepCaveat}` };
	}
	return {
		ok: false,
		error: `ego paused the agent task on this space ("its task has ended"), so ${action} could not run; the space is still listed with ownership "${ownership}"`,
		hint: `Call ego_app_space{action:"list"} and react to ownership "${ownership}": ${ownership === "user" ? "the space is finished, so finish/complete/mark_error/close have nothing left to do" : ownership === "agentDelegatedToUser" ? "control is with the user — run wait_control/takeover with this space's name first" : "re-check the flow before retrying"}.`
	};
}

export function apply(ctx, config) {
	if (config.announceToAgent !== false) {
		ctx.systemPrompt.section({
			name: "tool:ego-app",
			order: 118,
			text: "The ego_app_* tools drive the user's installed ego lite application (the real app, not Chrome/Edge): every call runs inside a real ego TaskSpace that is visible in the app's Space panel with the user's real profile and logins. Typical flow: ego_app_space{action:'open',name} → ego_app_navigate → ego_app_snapshot → ego_app_click/ego_app_fill → ego_app_snapshot. ego_app_run executes any official ego-browser script (taskSpace(), page.*, ego.*) and is the escape hatch for anything the structured tools do not cover. Use ego_app_space{action:'handoff'} when the user must log in or solve a CAPTCHA. Do not confuse these with browser_* (DSH extension bridge, drives another browser) or the ego-browser skill (same app, script-only)."
		});
	}

	// Failure shape shared by every tool: keep the CLI's own text and, when the
	// outcome carries one, the actionable hint (onboarding, control handoff, ...).
	// Post-condition failures raised inside generated scripts carry no hint of
	// their own, so derive one from the text instead of leaving the caller stuck.
	const fail = (out) => lossless({ ok: false, error: out.error, hint: hintFor(out.error) ?? out.hint, output: out.output, stderr: out.stderr });

	const pageTool = (toolName, description, parameters, build) => {
		ctx.tools.register(defineTool({
			output: OUT,
			name: toolName,
			description,
			parameters,
			async execute(args, exec) {
				const plan = build(args ?? {});
				if (typeof plan === "string") return { ok: false, error: plan };
				const out = await runScript(config, buildScript(plan), { signal: exec?.signal });
				if (!out.ok) {
					if (/Control of this task space is with the user/.test(out.error ?? "")) {
						return {
							ok: false,
							error: out.error,
							hint: "Control is with the user (handoff/takeover). Call ego_app_space{action:\"wait_control\"} until the agent gets control back, or ask the user to hand it back in the app."
						};
					}
					return fail(out);
				}
				return lossless({ ok: true, ...(out.result ?? {}) });
			}
		}));
	};

	// ── app level ───────────────────────────────────────────────────────────
	ctx.tools.register(defineTool({
		output: OUT,
		name: "ego_app_status",
		description: "Check the ego lite app bridge: resolved ego-browser CLI, app version, every TaskSpace (id/name/ownership/profile/tabs), profiles, and the app-level tab list. Run this first when an ego_app_* call fails.",
		parameters: {},
		async execute(_args, exec) {
			const out = await runScript(config, `${readSpacesHelper}// Every field is diagnostic, so a failing sub-read is reported, never silently
// replaced by an error object (an object with .error is not version data).
let version = null;
let versionError = null;
try {
  const __versionRead = await ego.getBrowserVersion();
  if (__versionRead && typeof __versionRead === "object" && typeof __versionRead.error === "string") versionError = __versionRead.error;
  else version = __versionRead;
} catch (error) { versionError = String(error && error.message ? error.message : error).slice(0, 300); }
const spaces = await readTaskSpaces("reading the space list");
let profiles = [];
let profilesError = null;
try {
  const __profilesRead = await ego.listProfiles();
  if (__profilesRead && typeof __profilesRead === "object" && typeof __profilesRead.error === "string") profilesError = __profilesRead.error;
  else profiles = (__profilesRead && __profilesRead.profiles) || __profilesRead || [];
} catch (error) { profilesError = String(error && error.message ? error.message : error).slice(0, 300); }
// ego.listTabs() only answers while a TaskSpace is selected, and every CLI run
// starts with nothing selected — so a bare status call always saw
// EGO_TASK_SPACE_NOT_SELECTED and reported tabs:[] forever. Select the newest
// agent space for the read (the selection every other tool makes anyway) and
// keep the failure text when even that cannot be read.
let tabs = [];
let tabsError = null;
let tabsSpaceId = null;
const __statusSpace = spaces.slice().reverse().find((s) => s.ownership === "agent") ?? null;
try {
  tabs = readTabsList(await ego.listTabs(), "reading the app tab list");
} catch (firstError) {
  if (__statusSpace) {
    try {
      await taskSpace(__statusSpace.id);
      tabs = readTabsList(await ego.listTabs(), "reading the app tab list after selecting space " + __statusSpace.id);
      tabsSpaceId = __statusSpace.id;
    } catch (retryError) {
      tabsError = String(retryError && retryError.message ? retryError.message : retryError).slice(0, 300);
    }
  } else {
    tabsError = String(firstError && firstError.message ? firstError.message : firstError).slice(0, 300);
  }
}
${print(`{ version, versionError, profiles, profilesError, tabs, tabsError, tabsSpaceId, spaces: spaces.map((s) => ({ id: s.id, name: s.name, ownership: s.ownership, profile: s.profileName, tabs: s.recentTabTitles || [] })) }`)}`, { signal: exec?.signal });
			return lossless({ ok: out.ok, executable: resolveExecutable(config), ...(out.ok ? { data: out.result } : { error: out.error, hint: hintFor(out.error) ?? out.hint, output: out.output, stderr: out.stderr }) });
		}
	}));

	ctx.tools.register(defineTool({
		output: OUT,
		name: "ego_app_space",
		description: "Manage ego lite TaskSpaces (the app's native Spaces) and agent task state. Actions: list | open (resume or create by name) | create | use | claim | pages | tabs | open_page | adopt | release | user_page | wait_control | handoff | takeover | finish | complete | mark_error | set_state | close | delete. Control handoff (handoff/takeover) is how a user takes over for login or CAPTCHA.",
		parameters: {
			action: { type: "string", description: "list | open | create | use | claim | pages | tabs | open_page | adopt | release | user_page | wait_control | handoff | takeover | finish | complete | mark_error | set_state | close | delete" },
			name: { type: "string", description: "TaskSpace name (used by open/create/...); reuse one name for the whole goal." },
			id: { type: "number", description: "TaskSpace id. use/claim/delete act on it; every other action resolves it instead of name (and never creates a space)." },
			profileId: { type: "string", description: "Profile id for create; empty uses the app default profile." },
			page: { type: "string", description: "Page label for adopt/release, e.g. p1." },
			as: { type: "string", description: "adopt: optional label the adopted Page should take (ego prefers its own pN labels)." },
			message: { type: "string", description: "Error message for mark_error." },
			state: { type: "string", description: "Free-form agent state text for set_state, e.g. 'Filling the checkout form'." },
			keep: { type: "boolean", description: "finish: keep every page open (default true); false closes the space pages." },
			keepPages: { type: "array", items: { type: "string" }, description: "finish: explicit Page labels to keep, e.g. [\"p1\"]." },
			scope: { type: "string", description: "delete: 'task' resolves the space given by name/id and deletes just that one; 'all' is refused on purpose (it would delete the user's own spaces too)." },
			ids: { type: "array", items: { type: "number" }, description: "delete: explicit space ids." },
			force: { type: "boolean", description: "delete: attempt even when a space is still agent-owned (normally hangs — prefer close/finish first)." },
			timeoutMs: { type: "number", description: "wait_control: how long to wait for the agent to get control back (ms). Clamped to the plugin budget (config timeoutMs - 5000) and echoed back as timeoutMs/clamped." }
		},
		async execute(args, exec) {
			const action = args.action ?? "open";
			// Blank/whitespace names count as absent so an explicit id still wins.
			const spaceArg = typeof args.name === "string" && args.name.trim() !== "" ? args.name : (typeof args.id === "number" ? args.id : undefined);
			// Independent read-only probe: "is this space still listed, and with what
			// ownership?" It uses only ego.listTaskSpaces(), so it still runs while the
			// app is refusing browser commands for an agent task that already ended.
			const probeSpaceListing = (space) => runScript(config, `const __probeWanted = ${j(space ?? "")};
const __probeListed = await ego.listTaskSpaces();
const __probeOk = Boolean(__probeListed) && Array.isArray(__probeListed.taskSpaces);
const __probeAll = __probeOk ? __probeListed.taskSpaces : [];
const __probeIsId = typeof __probeWanted === "number" || /^\\d+$/.test(String(__probeWanted));
const __probeRow = !__probeOk || __probeWanted === "" ? null : __probeIsId ? __probeAll.find((s) => s.id === Number(__probeWanted)) : __probeAll.find((s) => s.name === __probeWanted);
${print(`{ readFailed: !__probeOk, listed: __probeOk ? Boolean(__probeRow) : true, ownership: !__probeOk ? "unreadable" : (__probeRow ? __probeRow.ownership : "closed"), spaceId: __probeRow ? __probeRow.id : null, name: __probeRow ? __probeRow.name : null }`)}`, { signal: exec?.signal });

			/**
			 * ego can end the agent task mid-action; verify with an independent list read
			 * before believing the "script never ran" outcome (decision table lives in
			 * decideEndedTaskOutcome, which is exported and unit-tested).
			 */
			const recoverEndedTask = async (action, space, wantsClosed, hasKeepPages, extras = {}) => {
				if (space === undefined) return undefined;
				// finish(keepPages) promises page-level outcomes the space list cannot verify.
				if (action === "finish" && hasKeepPages === true) return undefined;
				const probe = await probeSpaceListing(space);
				if (!probe.ok || !probe.result || probe.result.readFailed === true) return undefined;
				return decideEndedTaskOutcome({ action, space, wantsClosed: wantsClosed === true, ...extras, ...probe.result });
			};

			const wrap = async (script, options = {}) => {
				const out = await runScript(config, script, { signal: exec?.signal });
				if (!out.ok) {
					if (/Control of this task space is with the user/.test(out.error ?? "")) {
						return {
							ok: false,
							error: out.error,
							hint: "Control is with the user (handoff/takeover). Call ego_app_space{action:\"wait_control\"} until the agent gets control back before running browser commands."
						};
					}
					if (options.action && /no longer assigned to the agent|its task has ended|browser commands are paused/.test(out.error ?? "")) {
						const recovered = await recoverEndedTask(options.action, options.space, options.wantsClosed, options.hasKeepPages, options.extras);
						if (recovered) return lossless(recovered);
					}
					return fail(out);
				}
				return lossless({ ok: true, ...(out.result ?? {}) });
			};

			if (action === "list") {
				// Fail closed: ok:true + count:0 was indistinguishable from a broken
				// bridge and silently weakened every "list proves it" verification.
				return wrap(`${readSpacesHelper}const spaces = await readTaskSpaces("listing the TaskSpaces");
${print("{ count: spaces.length, spaces: spaces.map((s) => ({ id: s.id, name: s.name, ownership: s.ownership, profile: s.profileName, tabs: s.recentTabTitles || [] })) }")}`);
			}
			if (action === "create") {
				// createTaskSpace alone leaves the space without an active selection;
				// useTaskSpace(id) is what makes it the agent's working space.
				return wrap(`${readSpacesHelper}const created = await ego.createTaskSpace(${j(args.name ?? "dsh-ego-lite")}${args.profileId ? `, ${j(args.profileId)}` : ""});
const newId = created && (created.id ?? created.spaceId);
// Fail closed: useTaskSpace(undefined) used to be the next call, hiding the
// real cause behind a confusing "no space" error from ego.
if (newId === undefined || newId === null || newId === "") throw new Error("createTaskSpace() did not return a space id: " + describeRead(created) + "; no space was selected");
await ego.useTaskSpace(newId);
let spaces = [];
let spacesError = null;
try { spaces = await readTaskSpaces("refreshing the list after create"); } catch (e) { spacesError = String(e && e.message ? e.message : e).slice(0, 300); }
${print(`{ spaceId: newId, name: ${j(args.name ?? "dsh-ego-lite")}, spaces: spaces.map((s) => ({ id: s.id, name: s.name, ownership: s.ownership })), spacesError }`)}`);
			}
			if (action === "use" || action === "claim") {
				if (typeof args.id !== "number") return { ok: false, error: "id (number) is required" };
				const call = action === "use" ? `await ego.useTaskSpace(${args.id})` : `await ego.claimTaskSpace(${args.id}${args.name ? `, ${j(args.name)}` : ""})`;
				return wrap(`${readSpacesHelper}${call};
let spaces = [];
let spacesError = null;
try { spaces = await readTaskSpaces("refreshing the list after " + ${j(action)}); } catch (e) { spacesError = String(e && e.message ? e.message : e).slice(0, 300); }
${print("{ used: " + args.id + ", spaces: spaces.map((s) => ({ id: s.id, name: s.name, ownership: s.ownership })), spacesError }")}`);
			}
			if (action === "delete") {
				// ego.deleteSpaces(options) accepts {ids:number[]} or {scope:"all"|"task"}
				// (the runtime says so in its own argument error). Only ids are ever
				// passed through: scope:"all" would wipe every user-owned space in the
				// app, including the user's own, and scope:"task" is exactly "resolve
				// this one space and delete it" — both are made explicit here instead
				// of being silently ignored (which is what the declared-but-unread
				// `id`/`scope` parameters used to do).
				if (args.scope === "all") {
					return {
						ok: false,
						error: 'delete{scope:"all"} is refused: it would delete every user-owned TaskSpace in the app, including spaces the user created. Pass ids (or id) for the finished spaces you mean.',
						hint: "List the spaces with ego_app_space{action:'list'}, then pass the exact ids to delete."
					};
				}
				if (args.scope !== undefined && args.scope !== "task") {
					return { ok: false, error: `unknown delete scope "${args.scope}"; use "task" (together with name or id) or pass ids.` };
				}
				if (args.scope === "task" && !(Array.isArray(args.ids) && args.ids.length > 0) && typeof args.id !== "number" && !args.name) {
					return { ok: false, error: "delete{scope:'task'} needs the space it refers to: pass name or id." };
				}
				const explicitIds = Array.isArray(args.ids) && args.ids.length > 0
					? args.ids.map((n) => Number(n))
					: typeof args.id === "number" ? [Number(args.id)] : null;
				const idsExpr = explicitIds ? `[${explicitIds.join(",")}]` : "null";
				const forceExpr = args.force === true ? "true" : "false";
				// No space prelude: deleting finished spaces must work even when no
				// agent space is open (and must never create one as a side effect).
				return wrap(`${readSpacesHelper}const allSpaces = await readTaskSpaces("resolving the delete targets");
const wantedIds = ${idsExpr};
const wantedName = ${j(args.name ?? "")};
const targets = wantedIds
  ? allSpaces.filter((s) => wantedIds.includes(s.id))
  : wantedName === ""
    ? []
    : allSpaces.filter((s) => s.name === wantedName);
const missingIds = wantedIds ? wantedIds.filter((id) => !targets.some((s) => s.id === id)) : [];
if (missingIds.length > 0) throw new Error("no space with id " + missingIds.join(", ") + " is currently listed (if you just ran finish with keep:false the space is already gone, so there is nothing left to delete; otherwise it may have been closed or deleted); call ego_app_space{action:'list'} to check");
if (targets.length === 0) throw new Error("no space named '" + wantedName + "' is currently listed; pass ids or the name of a finished space");
if (!wantedIds && targets.length > 1) throw new Error("the name '" + wantedName + "' matches " + targets.length + " spaces (ids " + targets.map((s) => s.id).join(", ") + "); pass explicit ids so delete cannot remove more than intended");
const blocked = targets.filter((s) => s.ownership !== "user");
if (blocked.length > 0) throw new Error("deleteSpaces only removes user-owned (finished) spaces; still held by the agent: " + blocked.map((s) => s.id + ":" + (s.name || "(unnamed)")).join(", ") + ". Use ego_app_space{action:'close', name} (or finish/complete) first." + (${forceExpr} ? " (force:true cannot make ego delete an agent-owned space, so nothing was attempted for those ids)" : ""));
const delIds = targets.filter((s) => s.ownership === "user").map((s) => s.id);
if (delIds.length === 0) throw new Error("nothing was deleted: none of the target space(s) is user-owned. finish/close/complete makes a space user-owned first (force:true does not delete agent-owned spaces).");
let receipt = null;
if (delIds.length > 0) receipt = await ego.deleteSpaces({ ids: delIds });
// ego refreshes its space list asynchronously, so poll instead of reporting a
// snapshot taken before the delete landed. Deleting must never answer ok:true
// while an id it was asked to remove is still listed.
const leftover = await (async () => {
  const deadline = Date.now() + 2400;
  for (;;) {
    // A failed read is not evidence that the delete landed: throw, never guess.
    const listed = await readTaskSpaces("confirming the delete");
    const remaining = listed.map((s) => s.id).filter((id) => delIds.includes(id));
    if (remaining.length === 0 || Date.now() >= deadline) return remaining;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
})();
const skipped = receipt && Array.isArray(receipt.skippedRunningSpaceIds) ? receipt.skippedRunningSpaceIds : [];
if (leftover.length > 0 || skipped.length > 0) throw new Error("deleteSpaces() returned, but space(s) " + (leftover.length > 0 ? leftover.join(", ") : skipped.join(", ")) + " were still listed after ~2400 ms" + (skipped.length > 0 ? " (ego skipped running spaces)" : ""));
${print("{ deletedIds: delIds, stillListed: leftover, skippedRunningSpaceIds: skipped, receipt }")}`);
			}

			if (spaceArg === undefined) return { ok: false, error: "name (string) or id (number) is required for this action", hint: "Call ego_app_space{action:\"list\"} to get the id, or repeat the name the space was opened with. Page tools (navigate/snapshot/click/...) may omit name and use the newest agent space; space actions require the target explicitly." };

			if (action === "open") {
				// The only action allowed to create: taskSpace() is reuse-or-create,
				// which is exactly the documented "open (resume or create by name)".
				const out = await runScript(config, buildScript({
					space: spaceArg, createSpace: true, usePage: false,
					body: `const pages = (await task.pages()).map((p) => p.label);`,
					result: `{ spaceId: task.spaceId, name: task.name, ownership: task.ownership, pages }`
				}), { signal: exec?.signal });
				if (out.ok) return lossless({ ok: true, ...(out.result ?? {}) });
				const busy = /belongs to the user \(id (\d+)\)/.exec(out.error ?? "");
				if (busy) {
					return {
						ok: false,
						error: `TaskSpace "${args.name}" already exists as a user-owned space (id ${busy[1]}); ego will not take it over automatically.`,
						hint: `Ask the user whether you may work in it, then call ego_app_space{action:"claim", id:${busy[1]}, name:"${args.name}"}; otherwise pick a different name.`,
						spaceId: Number(busy[1])
					};
				}
				return fail(out);
			}
			if (action === "close") {
				// closeTaskSpace() answers before the app's space list drops the row
				// (~24–46 ms window), so a single read reports a successful close as a
				// failure. Poll until the id is actually gone; "still listed" after the
				// poll is the only failure this action may report. Ownership is never
				// the success criterion here: the stale read shows a transient "user".
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					body: spaceWatch +
						`const __closeReceipt = await ego.closeTaskSpace();` + NL +
						`if (__closeReceipt && typeof __closeReceipt === "object" && __closeReceipt.error) throw new Error('closeTaskSpace() refused: ' + __closeReceipt.error + (__closeReceipt.error_code ? ' (' + __closeReceipt.error_code + ')' : '') + (__closeReceipt.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL" ? ' — the TaskSpace is delegated to the user' : ''));` + NL +
						`const __closeState = await waitSpaceState(__spaceId, (s) => !s.listed, 2400);` + NL +
						`if (__closeState.readFailed) throw new Error('closeTaskSpace() returned, but the close could not be verified: the app space list is unreadable (it returned an error instead of the list within ~2400 ms)');` + NL +
						`if (__closeState.listed) throw new Error('closeTaskSpace() returned, but space ' + __spaceId + ' was still listed after ~2400 ms (observed ownership: ' + __closeState.ownership + ')');`,
					result: `{ spaceId: __spaceId, closed: true, ownership: __closeState.ownership, receipt: typeof __closeReceipt === "string" ? __closeReceipt : null }`
				}), { action, space: spaceArg });
			}
			if (action === "pages") {
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					body: `const __pagesRead = await task.pages();
if (!Array.isArray(__pagesRead)) throw new Error("task.pages() returned " + describeRead(__pagesRead) + " — the TaskSpace page list is unreadable");
const pages = __pagesRead.map((p) => p.label);
const __tabsRead = await task.tabs();
if (!Array.isArray(__tabsRead)) throw new Error("task.tabs() returned " + describeRead(__tabsRead) + " — the TaskSpace tab list is unreadable");
const tabs = __tabsRead.map((t) => ({ label: t.label, targetId: t.targetId, title: t.title, url: t.url, active: t.active, openedBy: t.openedBy }));`,
					result: `{ spaceId: __spaceId, pages, tabs }`
				}));
			}
			if (action === "tabs") {
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					body: `const __tabsRead = await task.tabs();
if (!Array.isArray(__tabsRead)) throw new Error("task.tabs() returned " + describeRead(__tabsRead) + " — the TaskSpace tab list is unreadable");
const tabs = __tabsRead.map((t) => ({ label: t.label, targetId: t.targetId, title: t.title, url: t.url, active: t.active, openedBy: t.openedBy }));`,
					result: `{ spaceId: __spaceId, tabs }`
				}));
			}
			if (action === "open_page") {
				// A new Page is the whole point of this action: an answer without one
				// must not become ok:true with the field dropped by lossless().
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					body: `const created = await task.newPage();
if (!created || typeof created.label !== "string") throw new Error("newPage() did not return a Page: " + describeRead(created) + " (no Page was opened)");`,
					result: `{ spaceId: __spaceId, page: created.label }`
				}));
			}
			if (action === "adopt") {
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					body: `const wanted = ${j(args.page ?? "p1")};
const __tabsRead = await task.tabs();
if (!Array.isArray(__tabsRead)) throw new Error("task.tabs() returned " + describeRead(__tabsRead) + " — the TaskSpace tab list is unreadable, so adopt cannot resolve a tab");
const tabs = __tabsRead;
const hit = wanted === ""
  ? tabs.find((t) => t.active)
  : (tabs.find((t) => t.label === wanted) ?? tabs.find((t) => String(t.targetId) === String(wanted)));
if (!hit) throw new Error("no matching tab; pass a page label or targetId from ego_app_space{action:'tabs'}");
const adopted = await task.adopt(hit.page${args.as ? `, { as: ${j(args.as)} }` : ""});
if (!adopted || typeof adopted.label !== "string") throw new Error("adopt() did not return a Page: " + describeRead(adopted) + " (nothing was adopted)");
// adopt() is only proven when the Page is managed afterwards; report the check
// instead of claiming success on the call's return value alone.
const __managedRead = await task.pages();
if (!Array.isArray(__managedRead)) throw new Error("task.pages() returned " + describeRead(__managedRead) + " — the TaskSpace page list is unreadable, so adopt cannot be verified");
const __managedLabels = __managedRead.map((p) => p.label);`,
					result: `{ spaceId: __spaceId, page: adopted.label, targetId: hit.targetId, verified: __managedLabels.includes(adopted.label) }`
				}));
			}
			if (action === "release") {
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					body: `const __releasedLabel = ${j(args.page ?? "p1")};` + NL +
						`await task.release(__releasedLabel);` + NL +
						`const __stillManagedRead = await task.pages();
if (!Array.isArray(__stillManagedRead)) throw new Error("task.pages() returned " + describeRead(__stillManagedRead) + " — the TaskSpace page list is unreadable, so release cannot be verified");
const __stillManaged = __stillManagedRead.map((p) => p.label).includes(__releasedLabel);` + NL +
						`if (__stillManaged) throw new Error("release(" + __releasedLabel + ") returned but the Page is still managed by the agent");`,
					result: `{ spaceId: task.spaceId, released: true }`
				}));
			}
			if (action === "user_page") {
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					// `await` keeps this working whether userPage() answers synchronously
					// or with a promise (awaiting a plain value is a no-op).
					body: `const page2 = await task.userPage();
const info = page2 ? await page2.info() : null;`,
					result: `{ spaceId: __spaceId, userPage: info ? { label: page2.label, ...info } : null }`
				}));
			}
			if (action === "wait_control") {
				if (badTimeout(args.timeoutMs)) return { ok: false, error: TIMEOUT_ERROR };
				// `timeoutMs` used to be read here but missing from the schema, so no
				// schema-driven caller could see it; it also let a request larger than
				// the plugin budget die as a bare 180 s CLI kill. Clamp and report.
				const requested = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
					? Math.max(0, Math.floor(args.timeoutMs))
					: null;
				const pluginBudget = Number(config.timeoutMs ?? 180000);
				const ceiling = Math.max(1000, Math.floor(pluginBudget - 5000));
				const effective = requested === null ? Math.min(165000, ceiling) : Math.min(Math.max(1000, requested), ceiling);
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					body: spaceWatch +
						`const __controlGot = await task.waitForControl({ timeout: ${effective} });` + NL +
						`const __controlState = await waitSpaceState(__spaceId, (s) => s.ownership === "agent", 2400);` + NL +
						`if (__controlState.readFailed) throw new Error('waitForControl() ran, but its outcome could not be verified: the app space list is unreadable (it returned an error instead of the list within ~2400 ms)');` + NL +
						`if (__controlState.ownership !== "agent") throw new Error('waitForControl() returned, but this TaskSpace is ' + __controlState.ownership + ', so control is NOT with the agent');`,
					result: `{ spaceId: __spaceId, control: true, ownership: __controlState.ownership, requestedTimeoutMs: ${requested === null ? "null" : requested}, timeoutMs: ${effective}, clamped: ${requested !== null && requested !== effective}, value: __controlGot === undefined ? true : __controlGot }`
				}), { action, space: spaceArg, extras: { requestedTimeoutMs: requested, timeoutMs: effective, clamped: requested !== null && requested !== effective } });
			}
			if (action === "handoff") {
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					body: spaceWatch +
						`await task.handOff();` + NL +
						`const __handoffState = await waitSpaceState(__spaceId, (s) => s.ownership === "agentDelegatedToUser", 2400);` + NL +
						`if (__handoffState.readFailed) throw new Error('handOff() ran, but its outcome could not be verified: the app space list is unreadable (it returned an error instead of the list within ~2400 ms)');` + NL +
						`if (__handoffState.ownership !== "agentDelegatedToUser") throw new Error('handOff() returned, but ownership is ' + __handoffState.ownership + ' (expected agentDelegatedToUser; observed after ~2400 ms)');`,
					result: `{ spaceId: __spaceId, handedOff: true, ownership: __handoffState.ownership }`
				}), { action, space: spaceArg });
			}
			if (action === "takeover") {
				// Official API is takeOverTaskSpace(spaceId) — the skill guide's own
				// resume example is `const task = await takeOverTaskSpace(7)`.
				// ego.takeOverTaskSpace() without an id targets no space at all, so read
				// the resulting ownership back instead of assuming it worked.
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					body: `const resumed = await takeOverTaskSpace(__spaceId);
if (!resumed || resumed.ownership !== "agent") throw new Error("takeOverTaskSpace(" + __spaceId + ") did not hand control back (ownership=" + (resumed && resumed.ownership) + "); a space finished with kept Pages cannot be resumed — use ego_app_space{action:\\"claim\\", id:" + __spaceId + "} if the user agrees.");`,
					result: `{ spaceId: __spaceId, tookOver: true, ownership: resumed.ownership, name: resumed.name }`
				}), { action, space: spaceArg, extras: { nameHint: typeof args.name === "string" && args.name.trim() !== "" ? args.name : null } });
			}
			if (action === "finish") {
				// task.finish({ keep }) accepts "all" or an array of Page labels, and
				// answers with a receipt ({ closedSpace, keptManagedLabels, ... }) that
				// proves the transition without relying on a re-read alone.
				const finishKeepClosed = !(Array.isArray(args.keepPages) && args.keepPages.length > 0) && args.keep === false;
				const keepExpr = Array.isArray(args.keepPages) && args.keepPages.length > 0
					? JSON.stringify(args.keepPages)
					: (args.keep === false ? "[]" : JSON.stringify("all"));
				const validate = Array.isArray(args.keepPages) && args.keepPages.length > 0
					? `const keepList = ${keepExpr};
const existing = (await task.pages()).map((p) => p.label);
const missing = keepList.filter((label) => !existing.includes(label));
if (missing.length > 0) throw new Error("keepPages not found: " + missing.join(", ") + "; existing pages: " + (existing.join(", ") || "(none)"));
`
					: "";
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					body: spaceWatch + validate +
						`const __finishReceipt = await task.finish({ keep: ${keepExpr} });` + NL +
						`const __finishWantsClosed = ${finishKeepClosed ? "true" : "false"} || Boolean(__finishReceipt && __finishReceipt.closedSpace === true);` + NL +
						`const __finishState = await waitSpaceState(__spaceId, (s) => (__finishWantsClosed ? !s.listed : (s.ownership === "user" || !s.listed)), 2400);` + NL +
						`if (__finishState.readFailed) throw new Error('finish() ran, but its outcome could not be verified: the app space list is unreadable (it returned an error instead of the list within ~2400 ms)');` + NL +
						`if (__finishState.listed && (__finishWantsClosed || __finishState.ownership !== "user")) throw new Error('finish() returned, but ownership is still ' + __finishState.ownership + ' after ~2400 ms' + (__finishWantsClosed ? ' and the space is still listed although keep:[] asked to close everything' : ''));`,
					result: `{ spaceId: __spaceId, finished: true, keep: ${keepExpr}, ownership: __finishState.ownership, receipt: __finishReceipt ?? null }`
				}), { action, space: spaceArg, wantsClosed: finishKeepClosed, hasKeepPages: Array.isArray(args.keepPages) && args.keepPages.length > 0, extras: { keepHint: Array.isArray(args.keepPages) && args.keepPages.length > 0 ? args.keepPages : (args.keep === false ? [] : "all") } });
			}
			if (action === "complete") {
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					body: spaceWatch +
						`const __completeReceipt = await ego.completeTaskSpace();` + NL +
						`const __completeState = await waitSpaceState(__spaceId, (s) => (s.ownership === "user" || !s.listed), 2400);` + NL +
						`if (__completeState.readFailed) throw new Error('completeTaskSpace() ran, but its outcome could not be verified: the app space list is unreadable (it returned an error instead of the list within ~2400 ms)');` + NL +
						`if (__completeState.listed && __completeState.ownership !== "user") throw new Error('completeTaskSpace() returned, but ownership is still ' + __completeState.ownership + ' after ~2400 ms');`,
					result: `{ spaceId: __spaceId, completed: true, ownership: __completeState.ownership, receipt: typeof __completeReceipt === "string" ? __completeReceipt : null }`
				}), { action, space: spaceArg });
			}
			if (action === "mark_error") {
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					body: spaceWatch +
						`const __errorReceipt = await ego.markTaskSpaceError(${j(args.message ?? "agent error")});` + NL +
						`const __errorState = await waitSpaceState(__spaceId, (s) => (s.ownership === "user" || !s.listed), 2400);` + NL +
						`if (__errorState.readFailed) throw new Error('markTaskSpaceError() ran, but its outcome could not be verified: the app space list is unreadable (it returned an error instead of the list within ~2400 ms)');` + NL +
						`if (__errorState.listed && __errorState.ownership !== "user") throw new Error('markTaskSpaceError() returned, but ownership is still ' + __errorState.ownership + ' after ~2400 ms');`,
					result: `{ spaceId: __spaceId, markedError: true, ownership: __errorState.ownership, receipt: typeof __errorReceipt === "string" ? __errorReceipt : null }`
				}), { action, space: spaceArg });
			}
			if (action === "set_state") {
				return wrap(buildScript({
					space: spaceArg, usePage: false,
					body: `await ego.setAgentTaskState(${j(args.state ?? "")});`,
					result: `{ spaceId: task.spaceId, state: ${j(args.state ?? "")} }`
				}));
			}
			return { ok: false, error: `unknown action: ${action}` };
		}
	}));

	ctx.tools.register(defineTool({
		output: OUT,
		name: "ego_app_tabs",
		description: "List, open or focus browser tabs. scope='app' uses the application-level tab list (ego.listTabs / ego.createTab); scope='space' uses the current TaskSpace's tabs (task.tabs). Opening a tab in a space creates a managed Page you can drive with the other ego_app_* tools.",
		parameters: {
			scope: { type: "string", description: "app (default) | space" },
			action: { type: "string", description: "list (default) | open" },
			url: { type: "string", description: "action=open: URL to open." },
			name: { type: "string", description: "TaskSpace name for scope=space." }
		},
		async execute(args, exec) {
			const scope = args.scope === "space" ? "space" : "app";
			const action = args.action ?? "list";
			// tabs is addressed by name only; a blank name means "the newest agent space".
			const spaceArg = typeof args.name === "string" && args.name.trim() !== "" ? args.name : undefined;
			if (action !== "list" && action !== "open") return { ok: false, error: `unknown tabs action "${action}"; use list or open.` };
			if (scope === "app" && action === "open" && String(args.url ?? "").trim() === "") {
				return { ok: false, error: 'url is required for action=open; pass "about:blank" explicitly if you really want a blank tab.' };
			}
			if (scope === "app") {
				// Fail closed: `tabs.tabs || []` reported a broken bridge as "no tabs".
				// The created tab is echoed too: createTab() answering an error object
				// (instead of throwing) used to leave ok:true with zero evidence.
				const body = action === "open"
					? `const __tabsBefore = readTabsList(await ego.listTabs(), "before opening a tab");
const created = await ego.createTab(${j(args.url ?? "about:blank")});
if (created && typeof created === "object" && typeof created.error === "string") throw new Error("createTab() returned an error instead of a tab: " + describeRead(created) + " (no tab was opened)");
const tabs = readTabsList(await ego.listTabs(), "after opening a tab");`
					: `const tabs = readTabsList(await ego.listTabs(), "listing the app tabs");`;
				// ego.listTabs() only reports tabs while a task space is selected.
				const resultExpr = action === "open"
					? `{ scope: "app", spaceId: __spaceId, created: describeRead(created), verified: tabs.length > __tabsBefore.length, tabs: tabs.map((t) => ({ index: t.index, title: t.title, url: t.url, active: t.active })) }`
					: `{ scope: "app", spaceId: __spaceId, tabs: tabs.map((t) => ({ index: t.index, title: t.title, url: t.url, active: t.active })) }`;
				const out = await runScript(config, buildScript({
					space: spaceArg, usePage: false,
					body,
					result: resultExpr
				}), { signal: exec?.signal });
				return out.ok ? lossless({ ok: true, ...(out.result ?? {}) }) : fail(out);
			}
			// Same contract for the per-space list: a non-array answer is unreadable,
			// not an empty TaskSpace.
			const tabsRead = `const __tabs = await task.tabs();
if (!Array.isArray(__tabs)) throw new Error("task.tabs() returned " + describeRead(__tabs) + " — the TaskSpace tab list is unreadable, so this call cannot report tabs");`;
			const body = action === "open"
				? `const created = await task.newPage();
if (!created || typeof created.label !== "string") throw new Error("newPage() did not return a Page: " + describeRead(created) + " (no Page was opened)");
${tabsRead}`
				: tabsRead;
			// targetId/openedBy are what adopt/release need to name a tab; the space
			// action already reported them, so this list must not be poorer than it.
			const resultExpr = action === "open"
				? `{ scope: "space", spaceId: __spaceId, opened: created.label, tabs: __tabs.map((t) => ({ label: t.label, targetId: t.targetId, title: t.title, url: t.url, active: t.active, openedBy: t.openedBy })) }`
				: `{ scope: "space", spaceId: __spaceId, tabs: __tabs.map((t) => ({ label: t.label, targetId: t.targetId, title: t.title, url: t.url, active: t.active, openedBy: t.openedBy })) }`;
			const out = await runScript(config, buildScript({
				space: spaceArg, usePage: false,
				body,
				result: resultExpr
			}), { signal: exec?.signal });
			return out.ok ? lossless({ ok: true, ...(out.result ?? {}) }) : fail(out);
		}
	}));

	// ── navigation / observation ────────────────────────────────────────────
	pageTool("ego_app_navigate", "Navigate a page in an ego TaskSpace (reusing page p1 by default) and wait for the load to settle. Returns the landing URL and title.",
		{ url: { type: "string", description: "Absolute URL to open." }, name: { type: "string", description: "TaskSpace name; omit for the newest agent space." }, page: { type: "string", description: "Page label, default p1." }, timeoutMs: { type: "number", description: "Navigation timeout in ms." } },
		(args) => {
			if (badTimeout(args.timeoutMs)) return TIMEOUT_ERROR;
			if (String(args.url ?? "").trim() === "") return "url is required: pass an absolute URL (use about:blank explicitly if you really want a blank page).";
			return {
			space: args.name, label: args.page ?? "p1",
			body: `await page.goto(${j(args.url ?? "about:blank")}${args.timeoutMs ? `, { timeout: ${Number(args.timeoutMs)} }` : ""});
const info = await page.info();`,
			result: `{ spaceId: task.spaceId, page: page.label, url: info.url, title: info.title }`
		};
		});

	pageTool("ego_app_snapshot", "Read a page as a semantic text tree with refs (@N) and loc= selectors that ego_app_click/ego_app_fill accept. scope=viewport (default) | full_page | subtree; pass root with the iframe ref from a previous snapshot to focus a frame's subtree.",
		{ name: { type: "string", description: "TaskSpace name; omit for the newest agent space." }, page: { type: "string", description: "Page label, default p1." }, scope: { type: "string", description: "viewport (default) | full_page | subtree" }, root: { type: "string", description: "subtree only: iframe ref from a previous snapshot, e.g. \"@12\"." } },
		(args) => {
			const requestedScope = args.scope ?? "viewport";
			if (!["viewport", "full_page", "subtree"].includes(requestedScope)) return `unknown snapshot scope "${requestedScope}"; use viewport | full_page | subtree.`;
			if (requestedScope !== "subtree" && args.root) return "root is only valid together with scope=subtree.";
			const scope = requestedScope === "full_page" ? "full_page" : requestedScope === "subtree" ? "subtree" : "only_within_viewport";
			if (scope === "subtree" && !args.root) return "scope=subtree needs root: the iframe ref (@N) printed by a previous snapshot.";
			const snapshotArg = scope === "subtree"
				? `{ scope: "subtree", root: ${j(args.root ?? "")} }`
				: `{ scope: ${j(scope)} }`;
			return {
				space: args.name, label: args.page ?? "p1",
				body: `const info = await page.info();
const snapshot = await page.snapshot(${snapshotArg});`,
				result: `{ spaceId: task.spaceId, page: page.label, scope: ${j(scope === "only_within_viewport" ? "viewport" : scope)}, url: info.url, title: info.title, snapshot }`
			};
		});

	pageTool("ego_app_screenshot", "Save a PNG screenshot of a page and return its absolute path (view it with an image tool).",
		{ name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." }, path: { type: "string", description: "Absolute path (forward slashes). Omit to use the system temp directory." } },
		(args) => ({
			space: args.name, label: args.page ?? "p1",
			body: `const shot = await page.screenshot(${args.path ? `{ path: ${j(args.path)} }` : ""});`,
			result: `{ spaceId: task.spaceId, page: page.label, screenshot: shot }`
		}));

	// ── interaction ─────────────────────────────────────────────────────────
	pageTool("ego_app_click", "Click an element. Accepts snapshot refs (@12 / ref=12), text=…, loc=css:/role:/href:, xpath=…, or a raw CSS selector; exactly one element must match. Returns receipt: { popups?, dialog? } describing popups the click opened and any dialog it raised. label is a short description drawn next to the visible agent cursor.",
		{ selector: { type: "string", description: "Target selector, ref or text=… locator." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." }, button: { type: "string", description: "left (default) | right | middle" }, clickCount: { type: "number", description: "Number of clicks (default 1)." }, label: { type: "string", description: "3-6 word description for the visible cursor." }, timeoutMs: { type: "number", description: "Action timeout in ms." } },
		(args) => {
			if (badTimeout(args.timeoutMs)) return TIMEOUT_ERROR;
			const opts = {};
			if (args.button) opts.button = args.button;
			if (args.clickCount) opts.clickCount = Number(args.clickCount);
			if (args.label) opts.label = args.label;
			if (args.timeoutMs) opts.timeout = Number(args.timeoutMs);
			return {
				space: args.name, label: args.page ?? "p1",
				body: `const receipt = await page.click(${j(args.selector ?? "")}${Object.keys(opts).length ? `, ${j(opts)}` : ""});
const info = await page.info();`,
				result: `{ clicked: ${j(args.selector ?? "")}, page: page.label, url: info.url, title: info.title, receipt: describeReceipt(receipt) }`
			};
		});

	pageTool("ego_app_fill", "Fill an input, textarea or contenteditable element (same selector syntax as ego_app_click). Returns receipt when the fill raises a popup or dialog.",
		{ selector: { type: "string", description: "Target selector or ref." }, value: { type: "string", description: "Text to put into the element." }, timeoutMs: { type: "number", description: "Action timeout in ms; raise it for elements far below the viewport (ego defaults to ~3s)." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			if (badTimeout(args.timeoutMs)) return TIMEOUT_ERROR;
			// `fill` without a value used to write "" (silently clearing the field).
			// An empty string stays a valid way to clear it, but it must be explicit.
			if (typeof args.value !== "string") return 'fill: value is required; pass value:"" to clear the field.';
			return {
				space: args.name, label: args.page ?? "p1",
				body: `const receipt = await page.fill(${j(args.selector ?? "")}, ${j(args.value)}${args.timeoutMs ? `, { timeout: ${Number(args.timeoutMs)} }` : ""});`,
				result: `{ filled: ${j(args.selector ?? "")}, valueLength: ${args.value.length}, receipt: describeReceipt(receipt) }`
			};
		});

	pageTool("ego_app_key", "Send keyboard input: action=press (page-level with selector, or global), type, insert_text, paste, down, up. paste accepts html for rich editors. Returns receipt when the key raises a popup or dialog.",
		{ action: { type: "string", description: "press (default) | type | insert_text | paste | down | up" }, key: { type: "string", description: "Key or chord for press/down/up, e.g. Enter, ControlOrMeta+A." }, text: { type: "string", description: "Text for type/insert_text/paste." }, html: { type: "string", description: "paste: rich HTML payload; text above becomes the plain-text fallback (ego passes { text, html })." }, selector: { type: "string", description: "Optional element to focus for action=press." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			const action = args.action ?? "press";
			const keyActions = ["press", "type", "insert_text", "paste", "down", "up"];
			if (!keyActions.includes(action)) return `unknown key action "${action}"; use one of ${keyActions.join(" | ")}.`;
			let statement;
			if (action === "type") statement = `await page.keyboard.type(${j(args.text ?? "")});`;
			else if (action === "insert_text") statement = `await page.keyboard.insertText(${j(args.text ?? "")});`;
			else if (action === "paste") statement = args.html
				? `await page.keyboard.paste({ text: ${j(args.text ?? "")}, html: ${j(String(args.html))} });`
				: `await page.keyboard.paste(${j(args.text ?? "")});`;
			else if (action === "down") statement = `await page.keyboard.down(${j(args.key ?? "Enter")});`;
			else if (action === "up") statement = `await page.keyboard.up(${j(args.key ?? "Enter")});`;
			else if (args.selector) statement = `await page.press(${j(args.selector)}, ${j(args.key ?? "Enter")});`;
			else statement = `await page.keyboard.press(${j(args.key ?? "Enter")});`;
			return { space: args.name, label: args.page ?? "p1", body: `const receipt = ${statement}\nconst info = await page.info();`, result: `{ action: ${j(action)}, page: page.label, url: info.url, title: info.title, receipt: describeReceipt(receipt) }` };
		});

	pageTool("ego_app_pointer", "Mouse-level actions for canvas/visual UIs: hover | dblclick | drag | scroll (wheel) | move | mouse_click | down | up. button selects left/right/middle. mouse_click takes explicit x/y OR one plain CSS selector (its centre); it does not accept snapshot refs — use ego_app_click{selector, button:'right'} for element-targeted clicks. Returns receipt when the action raises a popup or dialog.",
		{ action: { type: "string", description: "hover | dblclick | drag | scroll | move | mouse_click | down | up" }, button: { type: "string", description: "left (default) | right | middle; used by mouse_click/down/up/dblclick." }, selector: { type: "string", description: "hover/dblclick target; mouse_click accepts one plain CSS selector (refs and loc= are not supported there)." }, from: { type: "string", description: "drag source selector." }, to: { type: "string", description: "drag target selector." }, x: { type: "number", description: "X coordinate for scroll/move/mouse_click." }, y: { type: "number", description: "Y coordinate." }, deltaX: { type: "number", description: "Wheel delta X for scroll." }, deltaY: { type: "number", description: "Wheel delta Y for scroll." }, label: { type: "string", description: "3-6 word description." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			const action = args.action ?? "hover";
			const known = ["hover", "dblclick", "drag", "scroll", "move", "mouse_click", "down", "up"];
			if (!known.includes(action)) return `unknown pointer action "${action}"; use one of ${known.join(" | ")}.`;
			const labelArg = args.label ? `, ${j({ label: args.label })}` : "";
			const clickOpts = {};
			if (args.label) clickOpts.label = args.label;
			if (args.button) clickOpts.button = args.button;
			const clickArg = Object.keys(clickOpts).length > 0 ? `, ${j(clickOpts)}` : "";
			let prelude = "";
			let postlude = "";
			let call;
			if (action === "hover") call = `await page.hover(${j(args.selector ?? "")}${labelArg})`;
			else if (action === "dblclick") call = `await page.dblclick(${j(args.selector ?? "")}${clickArg})`;
			else if (action === "drag") call = `await page.dragAndDrop(${j(args.from ?? "")}, ${j(args.to ?? "")}${labelArg})`;
			else if (action === "scroll") call = `await page.mouse.wheel(${Number(args.deltaX ?? 0)}, ${Number(args.deltaY ?? 0)}${labelArg})`;
			else if (action === "move") call = `await page.mouse.move(${Number(args.x ?? 0)}, ${Number(args.y ?? 0)}${labelArg})`;
			else if (action === "down") call = `await page.mouse.down(${args.button ? j({ button: args.button }) : ""})`;
			else if (action === "up") call = `await page.mouse.up(${args.button ? j({ button: args.button }) : ""})`;
			else {
				// mouse.click() takes coordinates. Accept x/y, or ONE plain CSS selector
				// resolved to its centre. Never silently fall back to (0,0): that is a
				// real click position and used to "succeed" on refs and locators.
				const selector = typeof args.selector === "string" ? args.selector.trim() : "";
				const hasX = typeof args.x === "number";
				const hasY = typeof args.y === "number";
				if (selector !== "") {
					// Coordinate clicks need a real CSS selector. `css=` is the same raw
					// CSS in ego's grammar, so strip it; every other locator form (refs,
					// text=, loc=, xpath=, `>> nth=`, `:has-text(...)` — prefix OR suffix)
					// is refused here instead of being fed to document.querySelector().
					const cssSelector = plainCssFrom(selector);
					if (!cssSelector) {
						return `mouse_click does not accept snapshot refs or ego locators (got "${selector}"). Use ego_app_click{selector:"${selector}", button:"right"} for an element-targeted click, or pass x/y coordinates.`;
					}
					if (hasX || hasY) return "mouse_click takes either one plain CSS selector or x/y, not both.";
					prelude = `const __scrollBefore = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
const box = await page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); const rect = el.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }, ${j(cssSelector)});
if (!box) throw new Error("selector not found: " + ${j(cssSelector)});
`;
					call = `await page.mouse.click(box.x, box.y${clickArg})`;
					// Put the viewport back where it was before the pre-scroll (the click
					// itself is done; leaving a page scrolled is a side effect callers
					// do not expect from a coordinate click).
					// A dialog would block page.evaluate for ~15 s, so only restore when the
					// click did not open one (the next call answers it, not this one).
					postlude = "if (!(receipt && receipt.dialog)) { await page.evaluate((pos) => { window.scrollTo(pos.x, pos.y); }, __scrollBefore).catch(() => {}); }";
				} else {
					if (!hasX || !hasY) return "mouse_click needs x and y coordinates, or one plain CSS selector.";
					call = `await page.mouse.click(${Number(args.x)}, ${Number(args.y)}${clickArg})`;
				}
			}
			const body = postlude === ""
				? `${prelude}const receipt = ${call};`
				: `${prelude}let receipt = null; let __pointerError = null;
try { receipt = ${call}; } catch (error) { __pointerError = error; }
${postlude}
if (__pointerError) throw __pointerError;`;
			return { space: args.name, label: args.page ?? "p1", body, result: `{ action: ${j(action)}, page: page.label, receipt: describeReceipt(receipt) }` };
		});
	pageTool("ego_app_select", "Select an option in a <select>: pass value, label, or index (0-based). Returns receipt when the selection raises a popup or dialog.",
		{ selector: { type: "string", description: "Select element selector." }, value: { type: "string", description: "Option value or visible label." }, label: { type: "string", description: "Option visible label (wins over value)." }, index: { type: "number", description: "Zero-based option index." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			let option = "null";
			if (typeof args.index === "number") option = j({ index: Number(args.index) });
			else if (typeof args.label === "string" && args.label !== "") option = j({ label: args.label });
			else if (typeof args.value === "string") option = j({ value: args.value });
			else return 'select requires one of value, label, or index (an empty call would clear the selection; pass value:"" only if that is what you want).';
			return { space: args.name, label: args.page ?? "p1", body: `const receipt = await page.selectOption(${j(args.selector ?? "")}, ${option});`, result: `{ selected: ${j(args.selector ?? "")}, receipt: describeReceipt(receipt) }` };
		});

	pageTool("ego_app_wait", "Wait for a condition: selector | url | load_state | function | timeout.",
		{ for: { type: "string", description: "selector | url | load_state | function | timeout" }, selector: { type: "string", description: "Selector for for=selector." }, state: { type: "string", description: "visible | attached | hidden | detached (default visible); also load_state value." }, url: { type: "string", description: "URL glob for for=url." }, expression: { type: "string", description: "JS expression for for=function, evaluated in the page." }, timeoutMs: { type: "number", description: "Timeout in ms." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			if (badTimeout(args.timeoutMs)) return TIMEOUT_ERROR;
			const kind = args.for ?? "selector";
			const waitKinds = ["selector", "url", "load_state", "function", "timeout"];
			if (!waitKinds.includes(kind)) return `unknown wait target "${kind}"; use one of ${waitKinds.join(" | ")}.`;
			// Each kind needs its own argument; the old defaults waited for "" (an
			// empty selector), "**" (every URL matches instantly) or `true`.
			if (kind === "url" && String(args.url ?? "").trim() === "") return 'url is required for for="url" (a glob such as "**/dashboard").';
			if (kind === "selector" && String(args.selector ?? "").trim() === "") return 'selector is required for for="selector".';
			if (kind === "function" && String(args.expression ?? "").trim() === "") return 'expression is required for for="function".';
			const t = args.timeoutMs ? `, { timeout: ${Number(args.timeoutMs)} }` : "";
			let statement;
			if (kind === "url") statement = `await page.waitForURL(${j(args.url ?? "**")}${t});`;
			else if (kind === "load_state") statement = `await page.waitForLoadState(${j(args.state ?? "load")});`;
			else if (kind === "function") {
				const rawExpression = String(args.expression ?? "true");
				// Trailing semicolons are noise for both forms: `() => 1;` must not
				// classify as a function source and then get rejected as `( () => 1; )`.
				const normalized = normalizeSource(rawExpression);
				// A whole function source must not be wrapped in `() => (...)`: that makes
				// the arrow itself the (always truthy) value and the wait passes at once.
				const predicate = isFunctionSource(rawExpression) ? `(${normalized})` : `() => (${normalized})`;
				const problem = syntaxProblem(predicate);
				if (problem) return `wait{for:"function"} needs a valid function source or expression: ${problem}. Nothing ran (fix expression and retry).`;
				statement = `await page.waitForFunction(${predicate}, undefined${args.timeoutMs ? `, { timeout: ${Number(args.timeoutMs)} }` : ""});`;
			}
			else if (kind === "timeout") statement = `await page.waitForTimeout(${Number(args.timeoutMs ?? 1000)});`;
			else statement = `await page.waitForSelector(${j(args.selector ?? "")}, { state: ${j(args.state ?? "visible")}${args.timeoutMs ? `, timeout: ${Number(args.timeoutMs)}` : ""} });`;
			return { space: args.name, label: args.page ?? "p1", body: `${statement}\nconst info = await page.info();`, result: `{ waitedFor: ${j(kind)}, page: page.label, url: info.url, title: info.title }` };
		});

	// ── scripting / protocol / files / dialogs ──────────────────────────────
	pageTool("ego_app_js", "Evaluate JavaScript in the page. Pass fn (a function source, receives arg), or expression (a single expression, or statements that use return). mode settles the ambiguity: auto (default, punctuation heuristic) | expression | statements | function. Returns the JSON-serializable value.",
		{ fn: { type: "string", description: "Function source, e.g. (arg) => arg.list.map(x => x.text)" }, expression: { type: "string", description: "Expression source (document.title) or a statement body that returns a value." }, mode: { type: "string", description: "auto (default) | expression | statements | function: how to interpret expression. Use statements for 'const x = 1; return x;' and function for a whole function source." }, arg: { type: "json", description: "Optional JSON-serializable argument passed to fn." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			const expr = String(args.expression ?? "undefined");
			const mode = String(args.mode ?? "auto");
			const modes = ["auto", "expression", "statements", "function"];
			if (!modes.includes(mode)) return `unknown js mode "${mode}"; use one of ${modes.join(" | ")}.`;
			const statementMode = /;|\breturn\b|\bconst\b|\blet\b/.test(expr);
			// A function source is a value, not a statement body: evaluating it as an
			// expression makes page.evaluate return the function itself, which JSON
			// drops without a word. `mode:"auto"` therefore treats a function source
			// as function mode; explicit modes never switch on their own.
			const effectiveMode = args.fn ? "function"
				: mode === "auto" ? (isFunctionSource(expr) ? "function" : statementMode ? "statements" : "expression")
					: mode;
			// Value sources drop trailing semicolons (`() => 1;` and `1 + 1;` are both
			// wrapped in parentheses); a statements body keeps them.
			const valueSource = normalizeSource(args.fn !== undefined ? args.fn : expr);
			const source = effectiveMode === "function" ? `(${valueSource})`
				: effectiveMode === "statements" ? `() => { ${expr} }`
					: `() => (${normalizeSource(expr)})`;
			// Parse the exact source before spawning: a typo becomes a readable
			// error here instead of a bare CLI "SyntaxError" after a run that never
			// evaluated anything.
			const problem = syntaxProblem(source);
			if (problem) return `js: the ${effectiveMode} source is not valid JavaScript: ${problem}. Nothing ran (check quotes/brackets or pass mode explicitly).`;
			const arg = args.arg === undefined ? "undefined" : j(args.arg);
			const call = args.arg === undefined ? `page.evaluate(${source})` : `page.evaluate(${source}, ${arg})`;
			return { space: args.name, label: args.page ?? "p1", body: `const value = await ${call};`, result: `{ value }` };
		});

	pageTool("ego_app_cdp", "Send a raw CDP command: scope=page (page.cdp), scope=task (task.cdp for Target/Browser domains), or scope=app (ego.sendCDPMessage with a raw JSON string).",
		{ scope: { type: "string", description: "page (default) | task | app" }, method: { type: "string", description: "CDP method, e.g. Runtime.evaluate or Target.getTargets." }, params: { type: "json", description: "CDP params object." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			const params = args.params === undefined ? "{}" : j(args.params);
			const scope = args.scope ?? "page";
			if (!["page", "task", "app"].includes(scope)) return `unknown cdp scope "${scope}"; use page | task | app.`;
			if (scope === "app") {
				const message = j(JSON.stringify({ id: 1, method: args.method ?? "Runtime.enable", params: args.params ?? {} }));
				return { space: args.name, label: args.page ?? "p1", body: `const raw = ego.sendCDPMessage(${message});`, result: `{ scope: "app", method: ${j(args.method ?? "")}, raw: raw === undefined ? null : raw }` };
			}
			const target = scope === "task" ? "task" : "page";
			return { space: args.name, label: args.page ?? "p1", body: `const cdpResult = await ${target}.cdp(${j(args.method ?? "Runtime.enable")}, ${params});`, result: `{ scope: ${j(scope)}, method: ${j(args.method ?? "")}, result: cdpResult }` };
		});

	pageTool("ego_app_dialog", "Answer a native JS dialog (accept / dismiss). Prefer trigger: it clicks the element and answers the dialog it opens inside one call. Measured on ego 0.6.2.5: an unanswered dialog does NOT auto-dismiss between calls — it blocks every later round on that page (PageEvaluationTimeoutError after ~15s), so answer it as soon as a receipt reports receipt.dialog.",
		{ action: { type: "string", description: "accept (default) | dismiss" }, promptText: { type: "string", description: "Text typed into a prompt() before accepting." }, trigger: { type: "string", description: "Optional selector to click before answering." }, waitMs: { type: "number", description: "Milliseconds to wait after the trigger click (default 400)." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			const dialogAction = String(args.action ?? "accept").toLowerCase();
			if (dialogAction !== "accept" && dialogAction !== "dismiss") return `unknown dialog action "${args.action}"; use accept or dismiss.`;
			// waitForTimeout rejects a negative/NaN budget, and a trigger click that
			// already opened a dialog must still be answered: the settle delay is best
			// effort, never a reason to skip acceptDialog (a left-open dialog blocks the
			// page until some later call answers it). The cap keeps a typo like
			// waitMs: 999999999 from outliving the plugin's own CLI budget.
			const requestedWait = Number(args.waitMs ?? 400);
			const settleMs = Number.isFinite(requestedWait) && requestedWait > 0 ? Math.min(Math.floor(requestedWait), 30000) : 0;
			// Capture the click receipt too: `handled:false` + receipt is diagnosable,
			// `handled:false` alone is not. `promptText:""` is a real answer, so only
			// an absent promptText means "no text to type".
			const clickPart = args.trigger
				? `let receipt = null; let __dialogClickError = null;
try { receipt = await page.click(${j(args.trigger)}); } catch (error) { __dialogClickError = error; }` + NL + `try { await page.waitForTimeout(${settleMs}); } catch {}` + NL
				: "const receipt = null; const __dialogClickError = null;" + NL;
			const answerPart = dialogAction === "dismiss" ? "const handled = await page.dismissDialog();" : `const handled = await page.acceptDialog(${args.promptText === undefined ? "undefined" : j(args.promptText)});`;
			// Answering happens before the click error is re-thrown: a failed trigger
			// must never leave a dialog blocking the Page.
			const afterAnswer = `if (__dialogClickError) { var __dce = (__dialogClickError && __dialogClickError.message ? __dialogClickError.message : String(__dialogClickError)); throw new Error(__dce + " | the trigger click failed; any dialog it raised was still answered (handled=" + handled + ")"); }` + NL;
			return {
				space: args.name, label: args.page ?? "p1",
				body: clickPart + answerPart + afterAnswer,
				result: `{ handled: handled === true, action: ${j(dialogAction)}, trigger: ${j(args.trigger ?? null)}, receipt: describeReceipt(receipt) ?? null, note: handled === true ? null : "no dialog was open to answer; if the trigger should have raised one, retry after it settles (receipt shows what the click raised)" }`
			};
		});
	pageTool("ego_app_upload", "Set files on a file input (absolute paths). Returns receipt with any dialog the upload raises. Use ego_app_page{action:'file_chooser'} instead when a click opens the chooser.",
		{ selector: { type: "string", description: "File input selector." }, files: { type: "array", items: { type: "string" }, description: "Absolute file paths." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			const uploadFiles = Array.isArray(args.files) ? args.files.filter((f) => String(f ?? "").trim() !== "") : [];
			if (uploadFiles.length === 0) return "files must contain at least one absolute path; an empty list would clear the input.";
			return {
			space: args.name, label: args.page ?? "p1",
			body: `const receipt = await page.setInputFiles(${j(args.selector ?? "input[type=file]")}, ${j(uploadFiles)});`,
			result: `{ uploaded: ${j(uploadFiles)}, receipt: describeReceipt(receipt) }`
		};
		});

	pageTool("ego_app_download", "Trigger a browser download and save it to an absolute path in one call: arms waitForEvent(download) before the click, then download.saveAs(). Temporary files vanish when the script ends, so saving is required. If no download arrives, the error still carries the click receipt (so an alert that blocked the download is visible).",
		{ trigger: { type: "string", description: "Selector clicked to start the download; omit to only wait for one that is already triggered. A plain CSS selector is pre-scrolled." }, saveAs: { type: "string", required: true, description: "Absolute path with forward slashes; ego creates missing parent directories." }, url: { type: "string", description: "Optional: navigate to this URL before clicking the trigger." }, timeoutMs: { type: "number", description: "Wait timeout in ms (default 30000)." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			if (badTimeout(args.timeoutMs)) return TIMEOUT_ERROR;
			// required:true only proves the key exists; "" and whitespace still arrive here.
			if (String(args.saveAs ?? "").trim() === "") return "saveAs must be a non-empty absolute path, for example C:/Users/me/Downloads/report.pdf";
			const goto = args.url ? `await page.goto(${j(args.url)});` + NL : "";
			return {
				space: args.name, label: args.page ?? "p1",
				body: `${goto}const downloadPromise = page.waitForEvent("download", { timeout: ${Number(args.timeoutMs ?? 30000)} }).catch((e) => ({ __error: e }));` + NL +
					`${clickTriggerLines(args.trigger, args.timeoutMs)}const downloadOut = await downloadPromise;` + NL +
					`const downloadError = downloadOut && downloadOut.__error ? downloadOut.__error : null;` + NL +
					`const download = downloadError ? null : downloadOut;` + NL +
					`if (downloadError) { ${waiterErrorExpr("downloadError", "the download never started")} }` + NL +
					`if (!download) throw new Error("waitForEvent(download) resolved without a download");` + NL +
					`const meta = { url: typeof download.url === "function" ? download.url() : null, suggestedFilename: typeof download.suggestedFilename === "function" ? download.suggestedFilename() : null };` + NL +
					`await download.saveAs(${j(args.saveAs)});`,
				result: `{ action: "download", page: page.label, saved: ${j(args.saveAs)}, download: meta, receipt: describeReceipt(receipt) }`
			};
		});

	pageTool("ego_app_page", "Page-level operations not tied to an element: reload | close | focus | events | file_chooser (arm, optionally click a trigger, then set files) | fetch (options.saveAs asks ego to write the body to that path; the path is echoed back but this call does not verify the file) | wait_event (popup | download; download can saveAs).",
		{ action: { type: "string", description: "reload (default) | close | focus | events | file_chooser | fetch | wait_event" }, selector: { type: "string", description: "Element selector for action=focus." }, url: { type: "string", description: "URL for action=fetch." }, options: { type: "json", description: "fetch options for action=fetch: method, headers, body, saveAs (ego performs the write; the requested path is echoed as saveAs and is not verified here)." }, event: { type: "string", description: "Event for wait_event: popup (default) or download." }, trigger: { type: "string", description: "file_chooser / wait_event: element clicked AFTER the waiter is armed. Prefer a plain CSS selector: only CSS triggers are scrolled into view first, and a chooser opened by a programmatic click (ref/loc= trigger on a long page) may never appear." }, files: { type: "array", items: { type: "string" }, description: "file_chooser: absolute paths passed to chooser.setFiles()." }, saveAs: { type: "string", description: "wait_event(download): absolute path to save the artifact, forward slashes." }, timeoutMs: { type: "number", description: "Timeout in ms." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			if (badTimeout(args.timeoutMs)) return TIMEOUT_ERROR;
			const action = args.action ?? "reload";
			// Read the label BEFORE closing: afterwards the Page is gone and reporting
			// `page.label` would turn a successful close into `page: undefined`.
			if (action === "close") return { space: args.name, label: args.page ?? "p1", body: `const __closedLabel = page.label;` + NL + `await page.close();`, result: `{ action: "close", page: __closedLabel }` };
			if (action === "focus") return { space: args.name, label: args.page ?? "p1", body: `await page.focus(${j(args.selector ?? "")}${args.timeoutMs ? `, { timeout: ${Number(args.timeoutMs)} }` : ""});`, result: `{ action: "focus", selector: ${j(args.selector ?? "")} }` };
			if (action === "events") return { space: args.name, label: args.page ?? "p1", body: `const events = await page.events();`, result: `{ action: "events", events }` };
			if (action === "file_chooser") {
				// Arm the waiter before the click: a chooser that opens first is missed.
				const files = Array.isArray(args.files) ? args.files : [];
				const timeoutOpts = `{ timeout: ${Number(args.timeoutMs ?? 30000)} }`;
				const setLine = files.length > 0
					? `const result = await chooser.setFiles(${files.length === 1 ? j(files[0]) : j(files)});`
					: "const result = null;";
				return {
					space: args.name, label: args.page ?? "p1",
					body: `const chooserPromise = page.waitForFileChooser(${timeoutOpts}).catch((e) => ({ __error: e }));` + NL +
						`${clickTriggerLines(args.trigger, args.timeoutMs)}const chooserOut = await chooserPromise;` + NL +
						`const chooserError = chooserOut && chooserOut.__error ? chooserOut.__error : null;` + NL +
						`const chooser = chooserError ? null : chooserOut;` + NL +
						`if (chooserError) { ${waiterErrorExpr("chooserError", "the chooser never opened")} }` + NL +
						`if (!chooser) throw new Error("waitForFileChooser resolved without a chooser");` + NL +
						`${setLine}`,
					result: `{ action: "file_chooser", multiple: typeof chooser.isMultiple === "function" ? chooser.isMultiple() : null, files: ${j(files)}, dialog: result && result.dialog ? ((describeReceipt({ dialog: result.dialog }) || {}).dialog ?? null) : null, receipt: describeReceipt(receipt) }`
				};
			}

			if (action === "fetch") {
				// ego writes options.saveAs itself; echo the requested path so the
				// result does not imply more than "the body was fetched" (this call
				// cannot verify the file from the Page side).
				const fetchSaveAs = args.options && typeof args.options === "object" && typeof args.options.saveAs === "string" ? args.options.saveAs : null;
				return {
					space: args.name, label: args.page ?? "p1",
					body: `const response = await page.fetch(${j(args.url ?? "")}${args.options ? `, ${j(args.options)}` : ""});\nconst described = { status: response.status, url: response.url, ok: response.ok };`,
					result: `{ action: "fetch", response: described, saveAs: ${j(fetchSaveAs)} }`
				};
			}
			if (action === "wait_event") {
				// ego only supports the popup and download page events.
				const eventName = args.event ?? "popup";
				if (eventName !== "popup" && eventName !== "download") {
					return `wait_event only supports the "popup" and "download" page events (ego limitation); use ego_app_run for anything else.`;
				}
				const timeoutOpts = `{ timeout: ${Number(args.timeoutMs ?? 30000)} }`;
				if (eventName === "download") {
					const saveLine = args.saveAs ? NL + `await download.saveAs(${j(args.saveAs)});` : "";
					return {
						space: args.name, label: args.page ?? "p1",
						body: `const downloadPromise = page.waitForEvent("download", ${timeoutOpts}).catch((e) => ({ __error: e }));` + NL +
							`${clickTriggerLines(args.trigger, args.timeoutMs)}const downloadOut = await downloadPromise;` + NL +
							`const downloadError = downloadOut && downloadOut.__error ? downloadOut.__error : null;` + NL +
							`const download = downloadError ? null : downloadOut;` + NL +
							`if (downloadError) { ${waiterErrorExpr("downloadError", "the download never started")} }` + NL +
							`if (!download) throw new Error("waitForEvent(download) resolved without a download");` + NL +
							`const meta = { url: typeof download.url === "function" ? download.url() : null, suggestedFilename: typeof download.suggestedFilename === "function" ? download.suggestedFilename() : null };` + saveLine,
						result: `{ action: "wait_event", event: "download", saved: ${j(args.saveAs ?? null)}, download: meta, receipt: describeReceipt(receipt) }`
					};
				}
				return {
					space: args.name, label: args.page ?? "p1",
					body: `const popupPromise = page.waitForEvent("popup", ${timeoutOpts}).catch((e) => ({ __error: e }));` + NL +
						`${clickTriggerLines(args.trigger, args.timeoutMs)}const popupOut = await popupPromise;` + NL +
						`const popupError = popupOut && popupOut.__error ? popupOut.__error : null;` + NL +
						`const popup = popupError ? null : popupOut;` + NL +
						`if (popupError) { ${waiterErrorExpr("popupError", "the popup never opened")} }` + NL +
						`const described = popup ? { label: popup.label, targetId: popup.targetId } : null;`,
					result: `{ action: "wait_event", event: "popup", popup: described, receipt: describeReceipt(receipt) }`
				};
			}

			if (action !== "reload") return `unknown page action "${action}"; use one of reload | close | focus | events | file_chooser | fetch | wait_event.`;
			return { space: args.name, label: args.page ?? "p1", body: `await page.reload(${args.timeoutMs ? `{ timeout: ${Number(args.timeoutMs)} }` : ""});`, result: `{ action: "reload", page: page.label }` };
		});

	pageTool("ego_app_gesture", "Draw the agent's intent on screen: highlight a point or show a gesture (point/press/scroll/write/key/think/outcome).",
		{ action: { type: "string", description: "highlight (default) | gesture" }, x: { type: "number", description: "X coordinate." }, y: { type: "number", description: "Y coordinate." }, command: { type: "json", description: "Gesture object for action=gesture, e.g. {type:'press',x:120,y:240}." }, name: { type: "string", description: "TaskSpace name." } },
		(args) => {
			const gestureAction = args.action ?? "highlight";
			if (gestureAction !== "highlight" && gestureAction !== "gesture") return `unknown gesture action "${gestureAction}"; use highlight or gesture.`;
			return {
			space: args.name, usePage: false,
			body: gestureAction === "gesture"
				? `const shown = await ego.showAgentGesture(${args.command === undefined ? j({ type: "think", label: "working" }) : j(args.command)});`
				: `const shown = await ego.animationHighlightMouseToPosition(${Number(args.x ?? 0)}, ${Number(args.y ?? 0)});`,
			// ego's highlight call answers with a human string ("<spaceId> mouse highlight shown."),
			// so keep `shown` boolean and surface the raw text separately. An API
			// that answers nothing has not said "shown" — report null, not true.
			result: `{ spaceId: task.spaceId, shown: shown === false ? false : shown === undefined || shown === null ? null : true, detail: typeof shown === "string" ? shown.slice(0, 500) : null }`
		};
		});

	ctx.tools.register(defineTool({
		output: OUT,
		name: "ego_app_run",
		description: "Run one official ego-browser script inside a real ego lite TaskSpace — the escape hatch for anything the structured tools do not cover. API: const task = await taskSpace(name|id) (returns a Promise — await is required), await task.page('p1'), await task.newPage(), task.tabs(), task.adopt/release, task.handOff/finish, task.cdp; page.goto/reload/click/fill/press/selectOption/waitFor…/snapshot/screenshot/evaluate/cdp/mouse/keyboard; ego.* (spaces, tabs, profiles, gestures, CDP). Do not import Playwright. End with console.log('@@DSH_RESULT@@' + JSON.stringify({...})); plain console.log returns text.",
		parameters: {
			script: { type: "string", description: "Full JS (ESM, top-level await allowed). Runs in the ego runtime, not in the page; put browser-side code inside page.evaluate()." }
		},
		async execute(args, exec) {
			const script = String(args.script ?? "");
			if (script.trim() === "") return { ok: false, error: "script is required" };
			if (exec?.signal?.aborted) return { ok: false, error: "aborted" };
			// Plain console.log text is a documented ego_app_run behaviour, so this is
			// the one tool that accepts a run without a sentinel result.
			const out = await runScript(config, script, { allowPlainText: true, signal: exec?.signal });
			return lossless(out.ok
				? { ok: true, result: out.result, log: out.log, ...(out.truncated ? { truncated: true } : {}) }
				: { ok: false, error: out.error, hint: hintFor(out.error) ?? out.hint, output: out.output, log: out.log });
		}
	}));
}
