# dsh-ego-lite

Drive the **installed ego lite app** from DeepSeek Harness with 20 structured `ego_app_*` tools. Every call runs through the official `ego-browser` CLI and lands inside a real ego TaskSpace — visible in the app's Space panel, using the app's own profile and logins.

- No second Chromium, no CDP port, no browser extension
- Coexists with the official `ego-browser` skill (same IPC channel)
- Tool-level validation, readable errors, and explicit handling of ego's behavioural edges

## Install

Published on npm as [dsh-ego-lite](https://www.npmjs.com/package/dsh-ego-lite).

```powershell
# as a DSH plugin, from npm (recommended)
dsh plugin --profile web add dsh-ego-lite

# as a regular npm dependency in your own project
npm install dsh-ego-lite

# straight from GitHub
dsh plugin --profile web add github:Gideon-Chiang/dsh-ego-lite

# local development
dsh plugin --profile web add file:C:/path/to/dsh-ego-lite
```

Restart dsh afterwards (plugins are not hot-reloaded; the profile copy is a physical copy, so re-copy and restart after editing sources).

> `dsh plugin` installs the package into the selected profile. If you only want it as a Node dependency, use `npm install dsh-ego-lite`; at runtime `@deepseek-ai/dsh-tools` is supplied by the DSH host (optional peer) and does not need to be installed separately.

## Requirements

- ego lite installed and onboarded, and running
- DSH able to execute commands on the same machine (`danger-full-access` recommended)

The CLI is auto-detected under `C:\Program Files\Citro Labs\ego lite\Application\<version>\ego-browser.exe`; override with the `executable` config or `EGO_BROWSER_CLI`.

## Tool surface

`ego_app_status`, `ego_app_space` (list/open/create/use/claim/pages/tabs/open_page/adopt/release/user_page/wait_control/handoff/takeover/finish/complete/mark_error/set_state/close/delete), `ego_app_tabs`, `ego_app_navigate`, `ego_app_snapshot`, `ego_app_screenshot`, `ego_app_click`, `ego_app_fill`, `ego_app_key`, `ego_app_pointer`, `ego_app_select`, `ego_app_page`, `ego_app_wait`, `ego_app_js`, `ego_app_cdp`, `ego_app_dialog`, `ego_app_upload`, `ego_app_download`, `ego_app_gesture`, `ego_app_run`.

## Behaviour changes in 0.1.10

0.1.10 closes out 0.1.9: it separates "the state could not be read" from "the state was read but not verified", and finishes the audit residuals.

- **Fail-closed reads**: `ego_app_space{action:'list'}`, `ego_app_status`, `delete`, space-action resolution and the six polled post-checks now **fail** when `taskSpaces` cannot be read (the error contains `unreadable`; the hint says run `list`/`ego_app_status` and retry) — a broken read is never "no spaces / deleted / empty list". `ego_app_status` degrades a failed tab read (anything that is not a list) to `tabs: []` + `tabsError`. **Two classes, by design**: the list refresh after `create`/`use`/`claim` is **best-effort** — a read failure only adds `spacesError` and the call still returns `ok:true` (the action's own evidence, e.g. `spaceId`, is already there); while `list`/`ego_app_status`/`delete`/space-action resolution and the six post-checks **must** fail closed. Do not read this as "any read failure is an error".
- **Task-ended fallback parity**: recovered results now carry what the normal path would: `takeover` → `name` when it was addressed by name, `wait_control` → `requestedTimeoutMs`/`timeoutMs`/`clamped`/`value`, `finish` → `keep` (the requested value). A `finish(keep:true)` recovery note states that page-level retention cannot be verified from the space list — use the normal-path receipt when `keptManagedLabels` matters.
- **`timeoutMs` hygiene**: explicit `<= 0` / non-finite values are rejected before any side effect with `timeoutMs must be a positive number of milliseconds (it is a duration, not a flag).`; `ego_app_page{action:'reload'|'focus'}` now forwards `timeoutMs` (`close` takes none).
- **Locator quotes**: `>>` / `:has-text(` inside quoted CSS strings (`[data-x="a>>b"]`) is literal CSS, not an ego locator; markers outside quotes still go to ego's locator parser.
- **`ego_app_js` `mode`**: `auto | expression | statements | function` (default `auto` keeps the punctuation heuristic; `fn` implies `function`). `ego_app_wait{for:'function'}` accepts a whole function source instead of wrapping it in `() => (...)`, which made the wait pass immediately.
- **`pageCreated`**: **actual Page tools** (`navigate`/`snapshot`/`screenshot`/`click`/`fill`/`key`/`pointer`/`select`/`wait`/`js`/`cdp`/`dialog`/`upload`/`download`/`page`) now include `pageCreated` (`true` when a silent `newPage()` created the page); `ego_app_space{action:'open'}` and `ego_app_gesture` do **not** return it (matching 0.1.9); `open` also no longer creates a Page by itself (`usePage:false`) — a new space's `pages` may be empty and the first Page-tool call does the `newPage()`.
- **abort**: a caller AbortSignal kills the child process and returns `aborted by the caller` immediately instead of waiting for the plugin's 180 s timeout.
- **Sentinel nonce**: plugin-generated scripts use a per-run random suffix, so page text faking a whole `@@DSH_RESULT@@…` line can no longer spoof structured results. The nonce only replaces the plugin's own printed expression: **a user script containing the same literal (including `@@DSH_NONCE_SLOT@@`) is never rewritten**, and `ego_app_run` keeps the plain `@@DSH_RESULT@@` contract. A structured call that cannot find this run's token line gets a dedicated "no result line carrying this run's sentinel token" failure instead of the old "script never ran" message.
- **Rendered truncation marker**: results over 20000 characters now end with `…[renderedTruncated omittedChars=N limitChars=20000]` instead of being silently cut.
- **New hints**: `no space with id`, `only removes user-owned`, `matches N spaces`, `could not be read|could not be verified`.

## Behaviour changes in 0.1.9

- **Post-transition `ok:false`**: `close`/`finish`/`complete`/`mark_error`/`handoff`/`wait_control` now poll the space list (12×150 ms, ~2.4 s) and report the *measured* `ownership`. An action can land and still return `ok:false` (e.g. the close poll times out); read `error`/`hint`/`ownership` before retrying.
- **Task-ended output loss**: ego can hard-stop the script as a *consequence* of the action and drop buffered output (including the result sentinel), printing `This task space is no longer assigned to the agent: its task has ended … browser commands are paused` and exiting 0. For `close`/`finish`/`complete`/`mark_error`/`handoff`/`wait_control`/`takeover` the tool now re-reads the space list once and decides from that state. Terminal actions may return `{ok:true, …, receipt:null, verifiedBy:"listTaskSpaces", note:"…"}` — **`receipt:null` here is not a failure** (the receipt was dropped; the conclusion comes from the independent read, and `finish` also reports `keep:null` on this path). A gone space means `ownership:"closed"`; a space still listed as `user` counts as success for `finish(keep:true)`/`complete`/`mark_error`. `handoff`/`takeover`/`wait_control` also succeed when the independent read already shows the state they promise (`agentDelegatedToUser`/`agent`/`agent`) — `handedOff`/`tookOver`/`control` + `verifiedBy:"listTaskSpaces"` — instead of failing because the script did not finish; they still fail when the space is gone. **When the space was addressed by `name` and is gone, the recovered result has `spaceId: null`** (the id is only echoed when it was passed in): `spaceId:null` + `verifiedBy:"listTaskSpaces"` is a success, not a missing field. Two exceptions: `finish{keepPages:[...]}` is **not** recovered on this path (page-level outcomes cannot be verified from the space list; the original failure is kept), and `finish(keep:false)` still fails when the space is listed as `user` (it was told to close it). This recovery only runs when that notice is present *and* the outcome was already a failure; normal paths still carry ego's native receipt.
- **No implicit space creation**: only `open` may create a space. Every other space action resolves an existing one by `name`/`id` and fails with `… is currently open. This action only operates on an existing space; it never creates one.` — retrying `close` can no longer create a same-named space and "succeed". **Space actions (including `open`; except `list`/`create`) require `name` or `id` explicitly** — a whitespace-only name such as `"   "` counts as omitted — and are rejected by the host with `name (string) or id (number) is required for this action` (plus a hint, zero side effects) — a deliberate safety guard against touching the newest space. Only page tools (`ego_app_navigate`/`snapshot`/`click`/`fill`/…) may omit `name` and use the newest agent space (falling back to the newest `agentDelegatedToUser` space).
- **One vocabulary for a vanished space**: absence is reported as `ownership: "closed"` — success for `close`/`finish`/`complete`/`mark_error`, failure for `handoff`/`wait_control`/`takeover`.

## Known ego semantics (handled by the tools)

- `finish({ keep })` takes `"all"` or page labels; validated before calling
- After `handoff`/`takeover` browser commands are paused until `wait_control`; `wait_control`/`takeover` still need the space's `name`/`id` (space actions never default to the newest space)
- `deleteSpaces` removes user-owned spaces only; agent-owned ids hang. After deleting, `delete` polls the list and now **errors** when ids are still listed (or ego reports `skippedRunningSpaceIds`); the result carries `deletedIds`/`stillListed`/`skippedRunningSpaceIds`/`receipt`, and `id`/`scope:"task"` are accepted (`scope:"all"` is explicitly rejected). `force:true` cannot bypass agent-owned targets either: it still returns `ok:false` with `force:true cannot make ego delete…`, unknown ids are named, and a name matching several spaces is rejected in favour of explicit `ids`.
- Spaces in `agentDelegatedToUser` cannot be closed through any API — close them in the ego UI. `close` polls until the entry disappears, so a normal close is no longer reported as a failure; only an explicit refusal (receipt with `error`) or a space still listed after the poll is `ok:false` (with the observed ownership and a hint).
- **An unanswered JavaScript dialog is NOT auto-dismissed between calls.** Measured on ego 0.6.2.5: it blocks every later round on that page (~15 s, `PageEvaluationTimeoutError`). Answer it as soon as a `receipt.dialog` is reported, ideally with `ego_app_dialog{trigger}` in one call.
- Action **receipts** (`popups`, `dialog`) are returned by click/fill/key/pointer/select/upload/download/file_chooser; the key is omitted when the API returned nothing and `{}` when it returned a receipt with nothing to report. `finish` now also exposes ego's receipt under `receipt` (`closedSpace`, `keptManagedLabels`, `closedManagedLabels`, `preservedUnmanagedCount`); `complete`/`mark_error` expose ego's string as `receipt`.
- Downloads must call `saveAs()` inside the same script — `ego_app_download` does it for you.
- ego's default action timeout (~3 s) is not enough for elements far below the viewport. On long pages give `timeoutMs` (**budget >= 15 s**) or scroll the target into view first — 8 s usually still fails. `timeoutMs` is accepted by `click`/`fill`/`navigate`/`wait`/`wait_control` and the file/event tools; for `download`/`file_chooser`/`wait_event` (and the `ego_app_page` equivalents) it is the budget for the whole call: the trigger click gets what is left (>= 500 ms). `wait_control` clamps its `timeoutMs` to `config.timeoutMs - 5000` (upper bound 175 s with the default config; default 165 s when omitted) and reports `requestedTimeoutMs`/`timeoutMs`/`clamped`. `pointer` has no `timeoutMs`; since 0.1.10 `ego_app_page{action:'reload'|'focus'}` forwards it (`close` has none), and explicit `<= 0`/non-finite values are rejected before any side effect.
- A file picker only opens on a user-activated click. Plain CSS and `css=` triggers are pre-scrolled; `@ref` / `loc=` / `xpath=` triggers cannot be, so scroll manually before using them.
- `ego_app_pointer.mouse_click` takes x/y or one plain CSS selector (a leading `css=` is stripped), never a snapshot ref or locator. A CSS target is scrolled into view, clicked, and then the **original viewport position is restored**.
- `css=`, `>> nth=N` and the terminal `:has-text(...)` / `:text-is(...)` / `:text(...)` forms go to ego's own locator parser and are never fed to `document.querySelector`.
- `ego_app_run` plain-text output above `maxOutputBytes` stays `ok:true` + `truncated:true`; the budget counts UTF-8 bytes, not UTF-16 code units.
- **A failed space-list read is not a vanished space**: when `listTaskSpaces()` returns an error object or no `taskSpaces`, `close`/`finish`/`complete`/`mark_error` now **fail** (their error carries `observed ownership: unreadable`, with a hint to run `list`/`ego_app_status` and retry) instead of reporting the space as closed and succeeding; the task-ended probe also gives up on a failed read and keeps the original error. `unreadable` means the state could not be confirmed — neither success nor a completed transition.
- **Hint precedence**: a concrete observation (`task has ended`, `unreadable`, the measured `ownership`) overrides the generic "check the installation / onboarding" hint, so the hint always matches the state actually observed.

See [docs/TEST-RUN-2026-11-01-0.1.10.md](docs/TEST-RUN-2026-11-01-0.1.10.md) for the 0.1.10 run log (unit **48/48**, live **89/89**, pointer-selector **11/11**). Historical logs: [TEST-RUN-2026-11-01-0.1.9.md](docs/TEST-RUN-2026-11-01-0.1.9.md) (0.1.9), [TEST-RUN-2026-10-31.md](docs/TEST-RUN-2026-10-31.md) (0.1.1–0.1.3), and [TEST-REPORT](docs/TEST-REPORT.md) is the 0.1.0 matrix (95/95; its appendix's "99" is a historical count, not the current suite).

## License

MIT. The ego lite application (Citro Labs) is neither bundled nor redistributed here.
