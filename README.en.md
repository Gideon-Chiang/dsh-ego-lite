# dsh-ego-lite

Drive the **installed ego lite app** from DeepSeek Harness with 19 structured `ego_app_*` tools. Every call runs through the official `ego-browser` CLI and lands inside a real ego TaskSpace — visible in the app's Space panel, using the app's own profile and logins.

- No second Chromium, no CDP port, no browser extension
- Coexists with the official `ego-browser` skill (same IPC channel)
- Tool-level validation, readable errors, and explicit handling of ego's behavioural edges

## Install

```powershell
dsh plugin --profile web add dsh-ego-lite
# or
dsh plugin --profile web add github:Gideon-Chiang/dsh-ego-lite
```

Restart dsh afterwards (plugins are not hot-reloaded; the profile copy is a physical copy, so re-copy and restart after editing sources).

## Requirements

- ego lite installed and onboarded, and running
- DSH able to execute commands on the same machine (`danger-full-access` recommended)

The CLI is auto-detected under `C:\Program Files\Citro Labs\ego lite\Application\<version>\ego-browser.exe`; override with the `executable` config or `EGO_BROWSER_CLI`.

## Tool surface

`ego_app_status`, `ego_app_space` (list/open/create/use/claim/pages/tabs/open_page/adopt/release/user_page/wait_control/handoff/takeover/finish/complete/mark_error/set_state/close/delete), `ego_app_tabs`, `ego_app_navigate`, `ego_app_snapshot`, `ego_app_screenshot`, `ego_app_click`, `ego_app_fill`, `ego_app_key`, `ego_app_pointer`, `ego_app_select`, `ego_app_page`, `ego_app_wait`, `ego_app_js`, `ego_app_cdp`, `ego_app_dialog`, `ego_app_upload`, `ego_app_gesture`, `ego_app_run`.

## Known ego semantics (handled by the tools)

- `finish({ keep })` takes `"all"` or page labels; validated before calling
- After `handoff`/`takeover` browser commands are paused until `wait_control`
- `deleteSpaces` removes user-owned spaces only; agent-owned ids hang
- Spaces in `agentDelegatedToUser` cannot be closed through any API — close them in the ego UI
- Dialogs are auto-dismissed between CLI invocations; use `ego_app_dialog{trigger}` to click and answer in one call

See [docs/TEST-REPORT.md](docs/TEST-REPORT.md) for the 99-case matrix.

## License

MIT. The ego lite application (Citro Labs) is neither bundled nor redistributed here.
