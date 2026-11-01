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

## Known ego semantics (handled by the tools)

- `finish({ keep })` takes `"all"` or page labels; validated before calling
- After `handoff`/`takeover` browser commands are paused until `wait_control`
- `deleteSpaces` removes user-owned spaces only; agent-owned ids hang
- Spaces in `agentDelegatedToUser` cannot be closed through any API — close them in the ego UI
- **An unanswered JavaScript dialog is NOT auto-dismissed between calls.** Measured on ego 0.6.2.5: it blocks every later round on that page (~15 s, `PageEvaluationTimeoutError`). Answer it as soon as a `receipt.dialog` is reported, ideally with `ego_app_dialog{trigger}` in one call.
- Action **receipts** (`popups`, `dialog`) are returned by click/fill/key/pointer/select/upload/download/file_chooser; the key is omitted when the API returned nothing and `{}` when it returned a receipt with nothing to report.
- Downloads must call `saveAs()` inside the same script — `ego_app_download` does it for you.
- ego's default action timeout (~3 s) is not enough for elements far below the viewport. On long pages give `timeoutMs` (**budget >= 15 s**) or scroll the target into view first — 8 s usually still fails.
- A file picker only opens on a user-activated click. CSS triggers are pre-scrolled; `@ref` / `loc=` triggers cannot be, so scroll manually before using them.
- `ego_app_pointer.mouse_click` takes x/y or one plain CSS selector, never a snapshot ref.

See [docs/TEST-RUN-2026-10-31.md](docs/TEST-RUN-2026-10-31.md) for the current run log (the older [TEST-REPORT](docs/TEST-REPORT.md) is the 0.1.0 matrix).

## License

MIT. The ego lite application (Citro Labs) is neither bundled nor redistributed here.
