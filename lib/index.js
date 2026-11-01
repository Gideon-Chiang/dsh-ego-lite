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
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "ego-lite";
export const inject = ["tools", "systemPrompt"];

const SENTINEL = "@@DSH_RESULT@@";
/** Newline used when composing generated scripts (readable in stack traces). */
const NL = String.fromCharCode(10);
const INSTALL_ROOT = "C:\\Program Files\\Citro Labs\\ego lite\\Application";

const OUT = {
	schema: { type: "object", additionalProperties: true },
	render: (_args, value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2).slice(0, 20000) }]
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

/** Run one script through the official CLI and parse the sentinel result. */
function runScript(config, script, options = {}) {
	const executable = resolveExecutable(config);
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-ego-"));
	const file = path.join(dir, "task.mjs");
	writeFileSync(file, script, { encoding: "utf8" });
	const entry = `await import(${JSON.stringify(pathToFileURL(file).href)})`;
	const limit = config.maxOutputBytes ?? 1048576;

	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let child;
		const finish = (payload) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
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
		const timer = setTimeout(() => {
			killTree(child.pid);
			finish({ ok: false, error: `ego-browser timed out after ${config.timeoutMs ?? 180000} ms` });
		}, config.timeoutMs ?? 180000);

		child.stdout.on("data", (chunk) => { if (stdout.length < limit) stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk) => { if (stderr.length < limit) stderr += chunk.toString("utf8"); });
		child.on("error", (error) => finish({ ok: false, error: `${executable}: ${error.message}` }));
		child.on("close", (code) => {
			// The ego runtime routes console.log to stderr, so the sentinel may arrive
			// on either stream; interpretCliOutcome handles both and the failure modes.
			finish(interpretCliOutcome({ code, stdout, stderr, allowPlainText: options.allowPlainText === true }));
		});
	});
}

/** Drop undefined-valued keys so tool results stay lossless JSON. */
const lossless = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = item;
  return out;
};
const j = (value) => JSON.stringify(value);
const print = (expression) => `console.log(${JSON.stringify(SENTINEL)} + JSON.stringify(${expression}));`;

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
export function interpretCliOutcome({ code, stdout = "", stderr = "", allowPlainText = false }) {
	const rows = [...stdout.split(/\r?\n/), ...stderr.split(/\r?\n/)];
	const sentinelLine = rows.find((row) => row.startsWith(SENTINEL));
	const clean = (text) => text.split(/\r?\n/).filter((row) => !row.startsWith(SENTINEL)).join("\n").trim();
	const log = clean(stderr) || clean(stdout);
	const stderrText = clean(stderr);
	if (sentinelLine) {
		try {
			return { ok: true, result: JSON.parse(sentinelLine.slice(SENTINEL.length)), log, stderr: stderrText };
		} catch {
			return { ok: false, error: `${SENTINEL} payload was not valid JSON: ${sentinelLine.slice(0, 500)}`, log, stderr: stderrText };
		}
	}
	const preflight = CLI_PREFLIGHT.find((entry) => entry.pattern.test(`${stdout}\n${stderr}`));
	if (preflight) return { ok: false, error: preflight.error, hint: preflight.hint, output: log.slice(0, 4000), log, stderr: stderrText };
	if (code !== 0) return { ok: false, error: (log || `ego-browser exited with code ${code}`).slice(0, 4000), log, stderr: stderrText };
	if (allowPlainText) return { ok: true, result: null, log, stderr: stderrText };
	return {
		ok: false,
		error: `ego-browser exited 0 without printing ${SENTINEL}, so the script never ran. CLI output: ${log.slice(0, 2000) || "(empty)"}`,
		hint: "Check that ego lite is installed, running, and past onboarding; set EGO_BROWSER_CLI (or the executable config) if the CLI lives elsewhere.",
		log,
		stderr: stderrText
	};
}

/** Resolve the target space: a name/id, or the newest agent space when omitted. Never creates a space. */
const spacePrelude = (space) => `const target = ${j(space ?? "")};
const task = target === "" ? await (async () => { const all = await ego.listTaskSpaces(); const mine = (all.taskSpaces || []).slice().reverse().find((s) => s.ownership === "agent"); if (!mine) throw new Error("no agent task space is open; call ego_app_space{action:\\"open\\", name} first (or pass name)"); return await taskSpace(mine.id); })() : await taskSpace(typeof target === "number" ? target : (/^\\d+$/.test(String(target)) ? Number(target) : target));
`;

const pagePrelude = (label) => `const wantedLabel = ${j(label ?? "p1")};
const knownPages = (await task.pages()).map((p) => p.label);
const page = knownPages.includes(wantedLabel) ? task.page(wantedLabel) : await task.newPage();
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
    const read = (name) => {
      try {
        const value = dialog[name];
        if (typeof value === "function") return value.call(dialog);
        return value === undefined ? null : value;
      } catch { return null; }
    };
    out.dialog = { type: read("type"), message: read("message"), defaultPrompt: read("defaultPrompt") };
  }
  return out;
};
`;

/**
 * Lines that arm nothing but do the click: optional pre-scroll for a plain CSS
 * trigger, the click itself, and a scroll restore so a trigger far down the page
 * does not leave the viewport parked there (ego does not reliably scroll back
 * up, so a later click on a top element times out).
 */
const clickTriggerLines = (trigger, timeoutMs) => {
	if (!trigger) return "const receipt = null;" + NL;
	const css = !/^(ref=|loc=|@|xpath=|text=)/.test(trigger);
	const wait = timeoutMs ? `, { timeout: ${Number(timeoutMs)} }` : "";
	const lines = [
		css ? "const __scrollBefore = await page.evaluate(() => window.scrollY);" : null,
		css ? `await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: "center" }); return true; }, ${j(trigger)});` : null,
		"let receipt = null; let __clickError = null;",
		`try { receipt = await page.click(${j(trigger)}${wait}); } catch (e) { __clickError = e; }`,
		css ? "await page.evaluate((y) => window.scrollTo(0, y), __scrollBefore).catch(() => {});" : null,
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
function buildScript({ space, label, usePage = true, body, result }) {
	return `${spacePrelude(space)}${usePage ? pagePrelude(label) + receiptPrelude : ""}${body}
${print(result)}`;
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
	const fail = (out) => lossless({ ok: false, error: out.error, hint: out.hint, output: out.output, stderr: out.stderr });

	const pageTool = (toolName, description, parameters, build) => {
		ctx.tools.register(defineTool({
			output: OUT,
			name: toolName,
			description,
			parameters,
			async execute(args) {
				const plan = build(args ?? {});
				if (typeof plan === "string") return { ok: false, error: plan };
				const out = await runScript(config, buildScript(plan));
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
				return { ok: true, ...(out.result ?? {}) };
			}
		}));
	};

	// ── app level ───────────────────────────────────────────────────────────
	ctx.tools.register(defineTool({
		output: OUT,
		name: "ego_app_status",
		description: "Check the ego lite app bridge: resolved ego-browser CLI, app version, every TaskSpace (id/name/ownership/profile/tabs), profiles, and the app-level tab list. Run this first when an ego_app_* call fails.",
		parameters: {},
		async execute() {
			const out = await runScript(config, `const version = await ego.getBrowserVersion();
const spaces = await ego.listTaskSpaces();
const profiles = await ego.listProfiles();
const tabs = await ego.listTabs();
${print(`{ version, profiles: profiles.profiles || profiles, tabs: tabs.tabs || tabs, spaces: (spaces.taskSpaces || []).map((s) => ({ id: s.id, name: s.name, ownership: s.ownership, profile: s.profileName, tabs: s.recentTabTitles || [] })) }`)}`);
			return lossless({ ok: out.ok, executable: resolveExecutable(config), ...(out.ok ? { data: out.result } : { error: out.error, hint: out.hint, output: out.output, stderr: out.stderr }) });
		}
	}));

	ctx.tools.register(defineTool({
		output: OUT,
		name: "ego_app_space",
		description: "Manage ego lite TaskSpaces (the app's native Spaces) and agent task state. Actions: list | open (resume or create by name) | create | use | claim | pages | tabs | open_page | adopt | release | user_page | wait_control | handoff | takeover | finish | complete | mark_error | set_state | close | delete. Control handoff (handoff/takeover) is how a user takes over for login or CAPTCHA.",
		parameters: {
			action: { type: "string", description: "list | open | create | use | claim | pages | tabs | open_page | adopt | release | user_page | wait_control | handoff | takeover | finish | complete | mark_error | set_state | close | delete" },
			name: { type: "string", description: "TaskSpace name (used by open/create/...); reuse one name for the whole goal." },
			id: { type: "number", description: "TaskSpace id (use/claim/delete)." },
			profileId: { type: "string", description: "Profile id for create; empty uses the app default profile." },
			page: { type: "string", description: "Page label for adopt/release, e.g. p1." },
			as: { type: "string", description: "adopt: optional label the adopted Page should take (ego prefers its own pN labels)." },
			message: { type: "string", description: "Error message for mark_error." },
			state: { type: "string", description: "Free-form agent state text for set_state, e.g. 'Filling the checkout form'." },
			keep: { type: "boolean", description: "finish: keep every page open (default true); false closes the space pages." },
			keepPages: { type: "array", items: { type: "string" }, description: "finish: explicit Page labels to keep, e.g. [\"p1\"]." },
			scope: { type: "string", description: "delete: 'task' (current space) or 'all'." },
			ids: { type: "array", items: { type: "number" }, description: "delete: explicit space ids." },
			force: { type: "boolean", description: "delete: attempt even when a space is still agent-owned (normally hangs — prefer close/finish first)." }
		},
		async execute(args) {
			const action = args.action ?? "open";
			const wrap = async (script) => {
				const out = await runScript(config, script);
				if (!out.ok) {
					if (/Control of this task space is with the user/.test(out.error ?? "")) {
						return {
							ok: false,
							error: out.error,
							hint: "Control is with the user (handoff/takeover). Call ego_app_space{action:\"wait_control\"} until the agent gets control back before running browser commands."
						};
					}
					return fail(out);
				}
				return { ok: true, ...(out.result ?? {}) };
			};

			if (action === "list") {
				return wrap(`const spaces = await ego.listTaskSpaces();
${print("{ count: (spaces.taskSpaces || []).length, spaces: (spaces.taskSpaces || []).map((s) => ({ id: s.id, name: s.name, ownership: s.ownership, profile: s.profileName, tabs: s.recentTabTitles || [] })) }")}`);
			}
			if (action === "create") {
				// createTaskSpace alone leaves the space without an active selection;
				// useTaskSpace(id) is what makes it the agent's working space.
				return wrap(`const created = await ego.createTaskSpace(${j(args.name ?? "dsh-ego-lite")}${args.profileId ? `, ${j(args.profileId)}` : ""});
const newId = created.id ?? created.spaceId;
await ego.useTaskSpace(newId);
const spaces = await ego.listTaskSpaces();
${print(`{ spaceId: newId, name: ${j(args.name ?? "dsh-ego-lite")}, spaces: (spaces.taskSpaces || []).map((s) => ({ id: s.id, name: s.name, ownership: s.ownership })) }`)}`);
			}
			if (action === "use" || action === "claim") {
				if (typeof args.id !== "number") return { ok: false, error: "id (number) is required" };
				const call = action === "use" ? `await ego.useTaskSpace(${args.id})` : `await ego.claimTaskSpace(${args.id}${args.name ? `, ${j(args.name)}` : ""})`;
				return wrap(`${call};
const spaces = await ego.listTaskSpaces();
${print("{ used: " + args.id + ", spaces: (spaces.taskSpaces || []).map((s) => ({ id: s.id, name: s.name, ownership: s.ownership })) }")}`);
			}
			if (action === "delete") {
				// ego.deleteSpaces only removes user-owned spaces; passing an
				// agent-owned id makes the runtime hang until the call times out,
				// so check ownership first and explain the way out.
				const idsExpr = Array.isArray(args.ids) && args.ids.length > 0 ? `[${args.ids.map((n) => Number(n)).join(",")}]` : "null";
				const forceExpr = args.force === true ? "true" : "false";
				// No space prelude: deleting finished spaces must work even when no
				// agent space is open (and must never create one as a side effect).
				return wrap(`const allSpaces = await ego.listTaskSpaces();
const wantedIds = ${idsExpr};
const wantedName = ${j(args.name ?? "")};
const targets = wantedIds
  ? (allSpaces.taskSpaces || []).filter((s) => wantedIds.includes(s.id))
  : wantedName === ""
    ? []
    : (allSpaces.taskSpaces || []).filter((s) => s.name === wantedName);
if (targets.length === 0) throw new Error(wantedIds
  ? "no space with id " + wantedIds.join(", ") + " is currently listed (it may already be closed or deleted); call ego_app_space{action:'list'} to check"
  : "no space named '" + wantedName + "' is currently listed; pass ids or the name of a finished space");
const blocked = targets.filter((s) => s.ownership !== "user");
if (blocked.length > 0 && !${forceExpr}) throw new Error("deleteSpaces only removes user-owned (finished) spaces; still held by the agent: " + blocked.map((s) => s.id + ":" + (s.name || "(unnamed)")).join(", ") + ". Use ego_app_space{action:'close', name} (or finish/complete) first, or pass force:true.");
const delIds = targets.filter((s) => s.ownership === "user").map((s) => s.id);
if (delIds.length > 0) await ego.deleteSpaces({ ids: delIds });
// ego refreshes its space list asynchronously, so poll briefly instead of
// reporting a snapshot taken before the delete landed.
const listedStill = async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const listed = await ego.listTaskSpaces();
    const remaining = (listed.taskSpaces || []).map((s) => s.id).filter((id) => delIds.includes(id));
    if (remaining.length === 0) return [];
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return delIds;
};
const stillListed = await listedStill();
${print("{ deletedIds: delIds, stillListed }")}`);
			}

			if (!args.name) return { ok: false, error: "name is required for this action" };

			if (action === "open") {
				const out = await runScript(config, buildScript({
					space: args.name,
					body: `const pages = (await task.pages()).map((p) => p.label);`,
					result: `{ spaceId: task.spaceId, name: task.name, ownership: task.ownership, pages }`
				}));
				if (out.ok) return { ok: true, ...(out.result ?? {}) };
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
				return wrap(buildScript({
					space: args.name, usePage: false,
					body: `await ego.closeTaskSpace();`,
					result: `{ spaceId: task.spaceId, closed: true }`
				}));
			}
			if (action === "pages") {
				return wrap(buildScript({
					space: args.name, usePage: false,
					body: `const pages = (await task.pages()).map((p) => p.label);
const tabs = (await task.tabs()).map((t) => ({ label: t.label, targetId: t.targetId, title: t.title, url: t.url, active: t.active, openedBy: t.openedBy }));`,
					result: `{ spaceId: task.spaceId, pages, tabs }`
				}));
			}
			if (action === "tabs") {
				return wrap(buildScript({
					space: args.name, usePage: false,
					body: `const tabs = (await task.tabs()).map((t) => ({ label: t.label, targetId: t.targetId, title: t.title, url: t.url, active: t.active, openedBy: t.openedBy }));`,
					result: `{ spaceId: task.spaceId, tabs }`
				}));
			}
			if (action === "open_page") {
				return wrap(buildScript({
					space: args.name, usePage: false,
					body: `const created = await task.newPage();`,
					result: `{ spaceId: task.spaceId, page: created.label }`
				}));
			}
			if (action === "adopt") {
				return wrap(buildScript({
					space: args.name, usePage: false,
					body: `const wanted = ${j(args.page ?? "p1")};
const tabs = await task.tabs();
const hit = wanted === ""
  ? tabs.find((t) => t.active)
  : (tabs.find((t) => t.label === wanted) ?? tabs.find((t) => String(t.targetId) === String(wanted)));
if (!hit) throw new Error("no matching tab; pass a page label or targetId from ego_app_space{action:'tabs'}");
const adopted = await task.adopt(hit.page${args.as ? `, { as: ${j(args.as)} }` : ""});`,
					result: `{ spaceId: task.spaceId, page: adopted.label }`
				}));
			}
			if (action === "release") {
				return wrap(buildScript({
					space: args.name, usePage: false,
					body: `const released = await task.release(${j(args.page ?? "p1")});`,
					result: `{ spaceId: task.spaceId, released: released === undefined ? true : released }`
				}));
			}
			if (action === "user_page") {
				return wrap(buildScript({
					space: args.name, usePage: false,
					body: `const page2 = task.userPage();
const info = page2 ? await page2.info() : null;`,
					result: `{ spaceId: task.spaceId, userPage: info ? { label: page2.label, ...info } : null }`
				}));
			}
			if (action === "wait_control") {
				return wrap(buildScript({
					space: args.name, usePage: false,
					body: `const got = await task.waitForControl();`,
					result: `{ spaceId: task.spaceId, control: true, value: got === undefined ? true : got }`
				}));
			}
			if (action === "handoff") {
				return wrap(buildScript({
					space: args.name, usePage: false,
					body: `await task.handOff();`,
					result: `{ spaceId: task.spaceId, handedOff: true }`
				}));
			}
			if (action === "takeover") {
				// Official API is takeOverTaskSpace(spaceId) — the skill guide's own
				// resume example is `const task = await takeOverTaskSpace(7)`.
				// ego.takeOverTaskSpace() without an id targets no space at all, so read
				// the resulting ownership back instead of assuming it worked.
				return wrap(buildScript({
					space: args.name, usePage: false,
					body: `const resumed = await takeOverTaskSpace(task.spaceId);
if (!resumed || resumed.ownership !== "agent") throw new Error("takeOverTaskSpace(" + task.spaceId + ") did not hand control back (ownership=" + (resumed && resumed.ownership) + "); a space finished with kept Pages cannot be resumed — use ego_app_space{action:\\"claim\\", id:" + task.spaceId + "} if the user agrees.");`,
					result: `{ spaceId: task.spaceId, tookOver: true, ownership: resumed.ownership, name: resumed.name }`
				}));
			}
			if (action === "finish") {
				// task.finish({ keep }) accepts "all" or an array of Page labels.
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
					space: args.name, usePage: false,
					body: `${validate}await task.finish({ keep: ${keepExpr} });`,
					result: `{ spaceId: task.spaceId, finished: true, keep: ${keepExpr} }`
				}));
			}
			if (action === "complete") {
				return wrap(buildScript({
					space: args.name, usePage: false,
					body: `await ego.completeTaskSpace();`,
					result: `{ spaceId: task.spaceId, completed: true }`
				}));
			}
			if (action === "mark_error") {
				return wrap(buildScript({
					space: args.name, usePage: false,
					body: `await ego.markTaskSpaceError(${j(args.message ?? "agent error")});`,
					result: `{ spaceId: task.spaceId, markedError: true }`
				}));
			}
			if (action === "set_state") {
				return wrap(buildScript({
					space: args.name, usePage: false,
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
		async execute(args) {
			const scope = args.scope === "space" ? "space" : "app";
			const action = args.action ?? "list";
			if (scope === "app") {
				const body = action === "open"
					? `const created = await ego.createTab(${j(args.url ?? "about:blank")});\nconst tabs = await ego.listTabs();`
					: `const tabs = await ego.listTabs();`;
				// ego.listTabs() only reports tabs while a task space is selected.
				const out = await runScript(config, buildScript({
					space: args.name, usePage: false,
					body,
					result: `{ scope: "app", spaceId: task.spaceId, tabs: (tabs.tabs || []).map((t) => ({ index: t.index, title: t.title, url: t.url, active: t.active })) }`
				}));
				return out.ok ? { ok: true, ...(out.result ?? {}) } : fail(out);
			}
			const body = action === "open"
				? `const created = await task.newPage();\nconst tabs = await task.tabs();`
				: `const tabs = await task.tabs();`;
			const out = await runScript(config, buildScript({
				space: args.name, usePage: false,
				body,
				result: `{ scope: "space", spaceId: task.spaceId, tabs: tabs.map((t) => ({ label: t.label, title: t.title, url: t.url, active: t.active })) }`
			}));
			return out.ok ? { ok: true, ...(out.result ?? {}) } : fail(out);
		}
	}));

	// ── navigation / observation ────────────────────────────────────────────
	pageTool("ego_app_navigate", "Navigate a page in an ego TaskSpace (reusing page p1 by default) and wait for the load to settle. Returns the landing URL and title.",
		{ url: { type: "string", description: "Absolute URL to open." }, name: { type: "string", description: "TaskSpace name; omit for the newest agent space." }, page: { type: "string", description: "Page label, default p1." }, timeoutMs: { type: "number", description: "Navigation timeout in ms." } },
		(args) => ({
			space: args.name, label: args.page ?? "p1",
			body: `await page.goto(${j(args.url ?? "about:blank")}${args.timeoutMs ? `, { timeout: ${Number(args.timeoutMs)} }` : ""});
const info = await page.info();`,
			result: `{ spaceId: task.spaceId, page: page.label, url: info.url, title: info.title }`
		}));

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
		(args) => ({
			space: args.name, label: args.page ?? "p1",
			body: `const receipt = await page.fill(${j(args.selector ?? "")}, ${j(args.value ?? "")}${args.timeoutMs ? `, { timeout: ${Number(args.timeoutMs)} }` : ""});`,
			result: `{ filled: ${j(args.selector ?? "")}, valueLength: ${String(args.value ?? "").length}, receipt: describeReceipt(receipt) }`
		}));

	pageTool("ego_app_key", "Send keyboard input: action=press (page-level with selector, or global), type, insert_text, paste, down, up. paste accepts html for rich editors. Returns receipt when the key raises a popup or dialog.",
		{ action: { type: "string", description: "press (default) | type | insert_text | paste | down | up" }, key: { type: "string", description: "Key or chord for press/down/up, e.g. Enter, ControlOrMeta+A." }, text: { type: "string", description: "Text for type/insert_text/paste." }, html: { type: "string", description: "paste: rich HTML payload; text above becomes the plain-text fallback (ego passes { text, html })." }, selector: { type: "string", description: "Optional element to focus for action=press." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			const action = args.action ?? "press";
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
					if (/^(ref=|loc=|@|xpath=|text=)/.test(selector)) {
						return `mouse_click does not accept snapshot refs or locators (got "${selector}"). Use ego_app_click{selector:"${selector}", button:"right"} for an element-targeted click, or pass x/y coordinates.`;
					}
					if (hasX || hasY) return "mouse_click takes either one plain CSS selector or x/y, not both.";
					prelude = `const box = await page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return null; const rect = el.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }, ${j(selector)});
if (!box) throw new Error("selector not found: " + ${j(selector)});
`;
					call = `await page.mouse.click(box.x, box.y${clickArg})`;
				} else {
					if (!hasX || !hasY) return "mouse_click needs x and y coordinates, or one plain CSS selector.";
					call = `await page.mouse.click(${Number(args.x)}, ${Number(args.y)}${clickArg})`;
				}
			}
			return { space: args.name, label: args.page ?? "p1", body: `${prelude}const receipt = ${call};`, result: `{ action: ${j(action)}, page: page.label, receipt: describeReceipt(receipt) }` };
		});
	pageTool("ego_app_select", "Select an option in a <select>: pass value, label, or index (0-based). Returns receipt when the selection raises a popup or dialog.",
		{ selector: { type: "string", description: "Select element selector." }, value: { type: "string", description: "Option value or visible label." }, label: { type: "string", description: "Option visible label (wins over value)." }, index: { type: "number", description: "Zero-based option index." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			let option = "null";
			if (typeof args.index === "number") option = j({ index: Number(args.index) });
			else if (args.label) option = j({ label: args.label });
			else if (typeof args.value === "string") option = j({ value: args.value });
			return { space: args.name, label: args.page ?? "p1", body: `const receipt = await page.selectOption(${j(args.selector ?? "")}, ${option});`, result: `{ selected: ${j(args.selector ?? "")}, receipt: describeReceipt(receipt) }` };
		});

	pageTool("ego_app_wait", "Wait for a condition: selector | url | load_state | function | timeout.",
		{ for: { type: "string", description: "selector | url | load_state | function | timeout" }, selector: { type: "string", description: "Selector for for=selector." }, state: { type: "string", description: "visible | attached | hidden | detached (default visible); also load_state value." }, url: { type: "string", description: "URL glob for for=url." }, expression: { type: "string", description: "JS expression for for=function, evaluated in the page." }, timeoutMs: { type: "number", description: "Timeout in ms." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			const kind = args.for ?? "selector";
			const t = args.timeoutMs ? `, { timeout: ${Number(args.timeoutMs)} }` : "";
			let statement;
			if (kind === "url") statement = `await page.waitForURL(${j(args.url ?? "**")}${t});`;
			else if (kind === "load_state") statement = `await page.waitForLoadState(${j(args.state ?? "load")});`;
			else if (kind === "function") statement = `await page.waitForFunction(() => (${args.expression ?? "true"}), undefined${args.timeoutMs ? `, { timeout: ${Number(args.timeoutMs)} }` : ""});`;
			else if (kind === "timeout") statement = `await page.waitForTimeout(${Number(args.timeoutMs ?? 1000)});`;
			else statement = `await page.waitForSelector(${j(args.selector ?? "")}, { state: ${j(args.state ?? "visible")}${args.timeoutMs ? `, timeout: ${Number(args.timeoutMs)}` : ""} });`;
			return { space: args.name, label: args.page ?? "p1", body: `${statement}\nconst info = await page.info();`, result: `{ waitedFor: ${j(kind)}, page: page.label, url: info.url, title: info.title }` };
		});

	// ── scripting / protocol / files / dialogs ──────────────────────────────
	pageTool("ego_app_js", "Evaluate JavaScript in the page. Pass fn (a function source, receives arg), or expression (a single expression, or statements that use return). Returns the JSON-serializable value.",
		{ fn: { type: "string", description: "Function source, e.g. (arg) => arg.list.map(x => x.text)" }, expression: { type: "string", description: "Expression source (document.title) or a statement body that returns a value." }, arg: { type: "json", description: "Optional JSON-serializable argument passed to fn." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			const expr = String(args.expression ?? "undefined");
			const statementMode = /;|\breturn\b|\bconst\b|\blet\b/.test(expr);
			const source = args.fn ? `(${args.fn})` : statementMode ? `() => { ${expr} }` : `() => (${expr})`;
			const arg = args.arg === undefined ? "undefined" : j(args.arg);
			const call = args.arg === undefined ? `page.evaluate(${source})` : `page.evaluate(${source}, ${arg})`;
			return { space: args.name, label: args.page ?? "p1", body: `const value = await ${call};`, result: `{ value }` };
		});

	pageTool("ego_app_cdp", "Send a raw CDP command: scope=page (page.cdp), scope=task (task.cdp for Target/Browser domains), or scope=app (ego.sendCDPMessage with a raw JSON string).",
		{ scope: { type: "string", description: "page (default) | task | app" }, method: { type: "string", description: "CDP method, e.g. Runtime.evaluate or Target.getTargets." }, params: { type: "json", description: "CDP params object." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			const params = args.params === undefined ? "{}" : j(args.params);
			const scope = args.scope ?? "page";
			if (scope === "app") {
				const message = j(JSON.stringify({ id: 1, method: args.method ?? "Runtime.enable", params: args.params ?? {} }));
				return { space: args.name, label: args.page ?? "p1", body: `const raw = ego.sendCDPMessage(${message});`, result: `{ scope: "app", method: ${j(args.method ?? "")}, raw: raw === undefined ? null : raw }` };
			}
			const target = scope === "task" ? "task" : "page";
			return { space: args.name, label: args.page ?? "p1", body: `const cdpResult = await ${target}.cdp(${j(args.method ?? "Runtime.enable")}, ${params});`, result: `{ scope: ${j(scope)}, method: ${j(args.method ?? "")}, result: cdpResult }` };
		});

	pageTool("ego_app_dialog", "Answer a native JS dialog (accept / dismiss). Prefer trigger: it clicks the element and answers the dialog it opens inside one call. Measured on ego 0.6.2.5: an unanswered dialog does NOT auto-dismiss between calls — it blocks every later round on that page (PageEvaluationTimeoutError after ~15s), so answer it as soon as a receipt reports receipt.dialog.",
		{ action: { type: "string", description: "accept (default) | dismiss" }, promptText: { type: "string", description: "Text typed into a prompt() before accepting." }, trigger: { type: "string", description: "Optional selector to click before answering." }, waitMs: { type: "number", description: "Milliseconds to wait after the trigger click (default 400)." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => ({
			space: args.name, label: args.page ?? "p1",
			body: `${args.trigger ? `await page.click(${j(args.trigger)});\nawait page.waitForTimeout(${Number(args.waitMs ?? 400)});\n` : ""}${args.action === "dismiss" ? "const handled = await page.dismissDialog();" : `const handled = await page.acceptDialog(${args.promptText ? j(args.promptText) : "undefined"});`}`,
			result: `{ handled: handled === true, action: ${j(args.action ?? "accept")}, trigger: ${j(args.trigger ?? null)} }`
		}));

	pageTool("ego_app_upload", "Set files on a file input (absolute paths). Returns receipt with any dialog the upload raises. Use ego_app_page{action:'file_chooser'} instead when a click opens the chooser.",
		{ selector: { type: "string", description: "File input selector." }, files: { type: "array", items: { type: "string" }, description: "Absolute file paths." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => ({
			space: args.name, label: args.page ?? "p1",
			body: `const receipt = await page.setInputFiles(${j(args.selector ?? "input[type=file]")}, ${j(args.files ?? [])});`,
			result: `{ uploaded: ${j(args.files ?? [])}, receipt: describeReceipt(receipt) }`
		}));

	pageTool("ego_app_download", "Trigger a browser download and save it to an absolute path in one call: arms waitForEvent(download) before the click, then download.saveAs(). Temporary files vanish when the script ends, so saving is required. If no download arrives, the error still carries the click receipt (so an alert that blocked the download is visible).",
		{ trigger: { type: "string", description: "Selector clicked to start the download; omit to only wait for one that is already triggered. A plain CSS selector is pre-scrolled." }, saveAs: { type: "string", required: true, description: "Absolute path with forward slashes; ego creates missing parent directories." }, url: { type: "string", description: "Optional: navigate to this URL before clicking the trigger." }, timeoutMs: { type: "number", description: "Wait timeout in ms (default 30000)." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
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

	pageTool("ego_app_page", "Page-level operations not tied to an element: reload | close | focus | events | file_chooser (arm, optionally click a trigger, then set files) | fetch (pass options.saveAs for binary) | wait_event (popup | download; download can saveAs).",
		{ action: { type: "string", description: "reload (default) | close | focus | events | file_chooser | fetch | wait_event" }, selector: { type: "string", description: "Element selector for action=focus." }, url: { type: "string", description: "URL for action=fetch." }, options: { type: "json", description: "fetch options for action=fetch: method, headers, body, saveAs." }, event: { type: "string", description: "Event for wait_event: popup (default) or download." }, trigger: { type: "string", description: "file_chooser / wait_event: element clicked AFTER the waiter is armed. Prefer a plain CSS selector: only CSS triggers are scrolled into view first, and a chooser opened by a programmatic click (ref/loc= trigger on a long page) may never appear." }, files: { type: "array", items: { type: "string" }, description: "file_chooser: absolute paths passed to chooser.setFiles()." }, saveAs: { type: "string", description: "wait_event(download): absolute path to save the artifact, forward slashes." }, timeoutMs: { type: "number", description: "Timeout in ms." }, name: { type: "string", description: "TaskSpace name." }, page: { type: "string", description: "Page label, default p1." } },
		(args) => {
			const action = args.action ?? "reload";
			if (action === "close") return { space: args.name, label: args.page ?? "p1", body: `await page.close();`, result: `{ action: "close", page: page.label }` };
			if (action === "focus") return { space: args.name, label: args.page ?? "p1", body: `await page.focus(${j(args.selector ?? "")});`, result: `{ action: "focus", selector: ${j(args.selector ?? "")} }` };
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

			if (action === "fetch") return {
				space: args.name, label: args.page ?? "p1",
				body: `const response = await page.fetch(${j(args.url ?? "")}${args.options ? `, ${j(args.options)}` : ""});\nconst described = { status: response.status, url: response.url, ok: response.ok };`,
				result: `{ action: "fetch", response: described }`
			};
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
			return { space: args.name, label: args.page ?? "p1", body: `await page.reload();`, result: `{ action: "reload", page: page.label }` };
		});

	pageTool("ego_app_gesture", "Draw the agent's intent on screen: highlight a point or show a gesture (point/press/scroll/write/key/think/outcome).",
		{ action: { type: "string", description: "highlight (default) | gesture" }, x: { type: "number", description: "X coordinate." }, y: { type: "number", description: "Y coordinate." }, command: { type: "json", description: "Gesture object for action=gesture, e.g. {type:'press',x:120,y:240}." }, name: { type: "string", description: "TaskSpace name." } },
		(args) => ({
			space: args.name, usePage: false,
			body: args.action === "gesture"
				? `const shown = await ego.showAgentGesture(${args.command === undefined ? j({ type: "think", label: "working" }) : j(args.command)});`
				: `const shown = await ego.animationHighlightMouseToPosition(${Number(args.x ?? 0)}, ${Number(args.y ?? 0)});`,
			// ego's highlight call answers with a human string ("<spaceId> mouse highlight shown."),
			// so keep `shown` boolean and surface the raw text separately.
			result: `{ spaceId: task.spaceId, shown: shown === false ? false : true, detail: typeof shown === "string" ? shown : null }`
		}));

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
			const out = await runScript(config, script, { allowPlainText: true });
			return lossless(out.ok
				? { ok: true, result: out.result, log: out.log }
				: { ok: false, error: out.error, hint: out.hint, output: out.output, log: out.log });
		}
	}));
}
