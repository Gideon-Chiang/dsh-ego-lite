# dsh-ego-lite

把**已安装的 ego lite 应用**接进 DeepSeek Harness：20 个结构化 `ego_app_*` 工具，全部走 ego 官方 `ego-browser` CLI，每次调用都落在**真实的 ego TaskSpace** 里（面板可见、可接管），用的是你应用自己的 profile 和登录态。

- 不启动额外的 Chrome/Edge，不需要 CDP 端口，不需要浏览器扩展
- 与 ego 官方 skill（`~/.agents/skills/ego-browser`）共用同一条 IPC 通道，可并存
- 有参数校验、可读错误、以及踩过的 ego 语义边界的显式提示

```
agent 调用 ego_app_* 工具
        ↓
dsh-ego-lite（本插件，host 侧 cordis 插件）
        ↓  写 UTF-8 .mjs → `ego-browser nodejs -e "await import(...)"`
ego lite 应用（TaskSpace / Page / CDP）
        ↓
你的真实浏览器：你的标签、你的登录态
```

## 为什么不是 CDP 方案

市面上的 ego 插件大多自带一个 Chromium 宿主，用 CDP 驱动 Chrome/Edge。它们在 ego 应用里**拿不到 Space**，因为 ego 应用不监听任何 CDP 端口（实测：ego 进程零 listening socket）。本插件直接对接应用自己的控制面，所以 Space 是原生的。

## 安装

已发布到 npm：[dsh-ego-lite](https://www.npmjs.com/package/dsh-ego-lite)。

```powershell
# 从 npm 安装为 DSH 插件（推荐）
dsh plugin --profile web add dsh-ego-lite

# 作为普通 npm 依赖安装到你自己的项目
npm install dsh-ego-lite

# 直接从 GitHub 安装
dsh plugin --profile web add github:Gideon-Chiang/dsh-ego-lite

# 本地开发
dsh plugin --profile web add file:C:/path/to/dsh-ego-lite
```

安装后**重启 dsh**（插件不支持热加载；profile 里的副本是复制，改源码后需重新复制并重启）。

> `dsh plugin` 会把包安装进对应 profile；如果你只是想在 Node 项目里依赖它，用 `npm install dsh-ego-lite` 即可。运行时 `@deepseek-ai/dsh-tools` 由 DSH 宿主提供（optional peer），不需要单独安装。

## 前置条件

| 要求 | 说明 |
|---|---|
| ego lite 已安装并完成 onboarding | 提供 `ego-browser` CLI 与运行时 |
| ego lite 正在运行 | CLI 通过 IPC 连接到正在运行的应用 |
| DSH 能在本机执行命令 | 建议 `danger-full-access` / Full access |

插件默认自动探测 `C:\Program Files\Citro Labs\ego lite\Application\<version>\ego-browser.exe`；可用配置项 `executable` 覆盖，或设置环境变量 `EGO_BROWSER_CLI`。

## 工具（20 个）

| 类别 | 工具 |
|---|---|
| 状态 | `ego_app_status`（CLI 路径、ego 版本、Space 列表、profile、app 级标签） |
| Space | `ego_app_space`：`list` `open` `create` `use` `claim` `pages` `tabs` `open_page` `adopt` `release` `user_page` `wait_control` `handoff` `takeover` `finish` `complete` `mark_error` `set_state` `close` `delete` |
| 标签 | `ego_app_tabs`（`scope: "app" | "space"`，可 `open`） |
| 导航/观察 | `ego_app_navigate`、`ego_app_snapshot`（viewport / full_page / subtree）、`ego_app_screenshot` |
| 交互 | `ego_app_click`、`ego_app_fill`、`ego_app_key`（press/type/insert_text/paste/down/up）、`ego_app_pointer`（hover/dblclick/drag/scroll/move/mouse_click/down/up）、`ego_app_select`、`ego_app_page`（reload/close/focus/events/file_chooser/fetch/wait_event） |
| 等待 | `ego_app_wait`（selector / url / load_state / function / timeout） |
| 脚本/协议 | `ego_app_js`、`ego_app_cdp`（page / task / app）、`ego_app_run`（任意官方脚本，逃生口） |
| 文件 | `ego_app_upload`（直接设 file input）、`ego_app_download`（先 arm `waitForEvent(download)` 再点击并 `saveAs` 落盘） |
| 其他 | `ego_app_dialog`（支持 `trigger` 同调用内点击并应答）、`ego_app_gesture` |

## 典型用法

```
ego_app_space   { action: "open", name: "查订单" }
ego_app_navigate{ name: "查订单", url: "https://example.com/orders" }
ego_app_snapshot{ name: "查订单" }
ego_app_fill    { name: "查订单", selector: "ref=3", value: "A123" }
ego_app_click   { name: "查订单", selector: "loc=role:button[name='查询']" }
ego_app_js      { name: "查订单", expression: "document.querySelector('#result').textContent" }
```

需要登录/验证码：`ego_app_space { action: "handoff", name: "查订单" }` 把控制权交给你，处理完再 `ego_app_space { action: "wait_control", ... }`。

任意官方 API 都能通过 `ego_app_run` 使用（`const task = await taskSpace(...)`、`await task.page('p1')`、`page.*`、`ego.*`、`fetch`）。注意 `taskSpace()` 返回 Promise，**必须 `await`**，否则会得到 `task.page is not a function`。

## ego 语义边界（实测，已被工具显式处理）

1. `task.finish({ keep })` 只接受 `"all"` 或页码数组 → 工具映射为 `keep: true/false` 或 `keepPages: ["p1"]`，并预校验标签是否存在。
2. `handoff`/`takeover` 后控制权在用户，浏览器命令会被硬暂停 → 返回带 `hint` 的错误，指向 `wait_control`。
3. `ego.createTaskSpace()` 之后必须 `useTaskSpace(id)` 才成为工作空间 → `create` 已内建。
4. 新建空间没有 `p1` → 页面前导自动 `newPage()`。
5. `mark_error` / `complete` 结束任务、归属翻回 `user`；同名 `open` 会返回结构化提示（附 id，建议 `claim` 或换名）。
6. `deleteSpaces` 只删 user-owned；传 agent-owned 会挂起到超时 → `delete` 先查归属并给可读错误，另提供 `force`。
7. **`agentDelegatedToUser` 空间（交还控制后）没有 API 能关闭**：`closeTaskSpace`/`claimTaskSpace`/`deleteSpaces` 均返回成功但不生效。需在 ego 面板手动关闭，或让用户先交还控制。
8. `ego_app_dialog` 的 `trigger` 参数在同一调用内点击并应答，`handled` 取真实返回值（跨调用的行为见第 14 条）。
9. `page.fetch` 受浏览器 CORS 约束；`page.waitForEvent` 只支持 `popup` / `download`。
10. agent 自己建的页面不能 `release`（只能 `close`）；用户页才需要 `adopt`。
11. `takeover` 的官方 API 是 `takeOverTaskSpace(spaceId)`，**必须带 id**；无参调用不切控制权却也不报错。工具现已按 id 调用并回读 `ownership` 校验。已 `finish` 且保留了页面的空间无法 `takeover`，只能 `claim`（需用户同意）。
12. `drag` 走原生 HTML5 拖放：**源元素必须 `draggable="true"`**，否则 `page.dragAndDrop()` 返回成功但页面没有任何事件（工具层看不出来，用 `ego_app_js` 回读真实状态验证）。
13. onboarding 未完成时 CLI 打印提示并**以退出码 0 退出**，不执行脚本也不产出结果 → 工具据此判定为失败并给出 hint，不会返回 `{ok:true, data:null}`。
14. `receipt.dialog` 报出的对话框必须**紧接着**用 `ego_app_dialog` 应答：实测 0.6.2.5 里未应答的对话框会跨调用残留，该页后续每轮都会超时（`ego_app_js` 报 `PageEvaluationTimeoutError`，约 15 s；guide 的"跨轮自动关闭"在此版本不成立）。
15. 下载必须在**同一脚本内** `saveAs()`：临时文件随该轮结束删除 → `ego_app_download` 已内建。
16. **ego 默认动作超时（约 3 s）对远在视口下方的元素不够用**：同一元素默认超时报 `element is not visible in the viewport`。实测在仓库自带 fixture 上：默认失败（3.0 s）→ `timeoutMs:8000` **仍然失败**（8.2 s）→ `15000` 通过（约 11.7 s）→ **先 `scrollIntoView` 再用默认超时通过（0.36 s）**。所以正确做法是「预算 ≥ 15 s」或「先把目标滚进视口」，不要照抄 8000。支持 `timeoutMs` 的有 `click`/`fill`/`file_chooser`/`download`/`wait_event`；`pointer` 没有这个参数。
17. **文件选择器只在用户激活的点击下打开**：ego 遇到需要先滚动进视口的元素时会退化成程序化 `element.click()`，Chromium 因此不弹选择框。工具已对**纯 CSS** trigger 先 `scrollIntoView` 再点击来保住真实输入；`@ref` / `loc=` / `xpath=` 的 trigger 无法预滚动，长页面上请先用 `ego_app_js` 滚进视口再调用。

## 与官方 skill 的关系

ego 官方推荐形态是 Agent Skill（`~/.agents/skills/ego-browser/`）+ `ego-browser nodejs` 脚本，没有 MCP。本插件不替代它，只是把同一条 CLI 包成结构化工具，省 token、带校验；需要复杂流程时用 `ego_app_run` 写完整脚本，与官方写法一致。

## 测试

99 项矩阵（页面交互、等待、CDP、对话框、生命周期、交还控制）全部通过，含会话内实测。详见 [docs/TEST-REPORT.md](docs/TEST-REPORT.md)。

- `npm test` —— 不需要 ego lite：CLI 输出判定（onboarding 预检、无哨兵、坏哨兵、非零退出等）9 项。
- `npm run test:live` —— 需要 ego lite 在运行、已完成 onboarding：
  - `test/live-e2e.mjs`（34 项）：动作回执、下载落盘、文件选择器超时与恢复、子树快照、富粘贴、指针右键等。
  - `test/pointer-selector.mjs`（11 项）：`mouse_click` 只接受 x/y 或纯 CSS 选择器，ref/loc= 必须报错而不是点 (0,0)。

测试页在 `test/fixtures/interaction.html`（带点击坐标捕获），可用 `EGO_E2E_FIXTURE` 指向别处；
ego lite 未运行时两个 live 套件会打印 SKIP 并以 0 退出；CI 里设 `EGO_E2E_REQUIRE=1` 则改为失败退出。
注意参数校验的两种错误形态：`ego_app_download` 缺 `saveAs` 由宿主直接抛 `ToolArgsError`（schema 必填），
其余工具的错误都以 `{ok:false, error}` 返回。

历史记录见 [docs/TEST-REPORT.md](docs/TEST-REPORT.md) 与 [docs/TEST-RUN-2026-10-31.md](docs/TEST-RUN-2026-10-31.md)。

## 许可

MIT。ego lite 本体（Citro Labs）不在本仓库内，也不随本包分发。
