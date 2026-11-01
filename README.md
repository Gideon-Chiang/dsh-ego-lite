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

需要登录/验证码：`ego_app_space { action: "handoff", name: "查订单" }` 把控制权交给你，处理完再 `ego_app_space { action: "wait_control", name: "查订单" }`。空间动作不会默认取最新空间，`wait_control`/`takeover` 必须带同一个 `name` 或 `id`（见 `ego_app_space{action:'list'}`）。

任意官方 API 都能通过 `ego_app_run` 使用（`const task = await taskSpace(...)`、`await task.page('p1')`、`page.*`、`ego.*`、`fetch`）。注意 `taskSpace()` 返回 Promise，**必须 `await`**，否则会得到 `task.page is not a function`。

## 行为变化（0.1.10，升级前必读）

0.1.10 是 0.1.9 的收尾轮：把「读不到状态」和「读到了但还没验证」彻底分开，并补掉 0.1.9 审计里的 S2 残留与 delta 项。

1. **读数失败 = 失败（fail-closed）**：`ego_app_space{action:'list'}`、`ego_app_status`、`delete`、空间动作的前置解析、以及六个「轮询后回读」动作（`close`/`finish`/`complete`/`mark_error`/`handoff`/`wait_control`），在拿不到 `taskSpaces` 数组时都**报失败**（错误含 `unreadable`，hint 指向先 `list`/`ego_app_status` 再重试），不再把「读失败」当成「没有空间 / 删除成功 / 空列表」。`ego_app_status` 的 tabs 读失败（返回的不是列表）时降级为 `tabs: []` + `tabsError`，空间列表本身成功时整体仍 `ok:true`。**注意区分两类**：`create`/`use`/`claim` 动作后的列表刷新是 **best-effort**——读失败只在结果里给 `spacesError`，仍返回 `ok:true`（动作本身已有 `spaceId` 等证据）；而 `list`/`ego_app_status`/`delete`/空间前置解析/六个回读**必须** fail-closed，读不到就报错——不要理解成「任何地方读失败都报错」。
2. **「任务结束丢输出」兜底的字段补齐**：兜底成功结果补齐宿主原本会返回的字段——`takeover` 按 name 调用时带 `name`（按 id 调用拿不到就不补），`wait_control` 带 `requestedTimeoutMs`/`timeoutMs`/`clamped`/`value`，`finish` 带 `keep`（宿主请求值）；`finish(keep:true)` 的 note 会明确「页面级保留无法用空间列表验证，需要 `keptManagedLabels` 请走正常路径回执」。
3. **`timeoutMs` 卫生**：显式 `<= 0` / 非有限值直接报 `timeoutMs must be a positive number of milliseconds (it is a duration, not a flag).`（在副作用之前拒绝）；`ego_app_page{action:'reload'|'focus'}` 现在**透传** `timeoutMs`（`close` 没有参数）。
4. **locator 引号不误判**：`[data-x="a>>b"]`、`[title=":has-text("]` 这类引号内含 locator 标记的**合法 CSS** 不再被误判为 ego locator；引号外的 `>>`/`:has-text(` 仍交给 ego 自己的 locator 解析。
5. **`ego_app_js` 的 `mode`**：新增 `mode: auto | expression | statements | function`（默认 `auto` 仍是标点启发式；`fn` 等价 `function`）。`ego_app_wait{for:'function'}` 现在接受**完整函数源码**，不再被包成 `() => (...)` 而恒真。
6. **`pageCreated` 可见**：**真正的 Page 工具**（`navigate`/`snapshot`/`screenshot`/`click`/`fill`/`key`/`pointer`/`select`/`wait`/`js`/`cdp`/`dialog`/`upload`/`download`/`page`）的结果都带 `pageCreated`（true = 本次调用静默 `newPage()` 建了页），不再有隐形建页；`ego_app_space{action:'open'}` 与 `ego_app_gesture` **不返回**该字段（与 0.1.9 一致）。另外 `open` 不再自动创建 Page（`usePage:false`）：新空间没有页时，第一次 Page 工具调用才 `newPage()`，`open` 的 `pages` 可能为空。
7. **abort 真取消**：调用方 AbortSignal 取消会 kill 子进程并立即返回 `aborted by the caller`，不再等到插件级 180 s 上限。
8. **哨兵 nonce**：插件生成的脚本，结构化结果哨兵带 per-run 随机后缀，页面文本伪造整行 `@@DSH_RESULT@@…` 不再能顶替结果。nonce 只替换插件自己生成的那一行打印表达式，**用户脚本里出现同名字面量（含 `@@DSH_NONCE_SLOT@@`）不会被改写**；`ego_app_run` 保持 plain `@@DSH_RESULT@@` 契约。结构化调用若拿不到本次 run 的哨兵行，会专门报「没有携带本次运行 token 的结果行」，不再误称「脚本没跑」。
9. **render 截断有标记**：结果超过 20000 字符时显示 `…[renderedTruncated omittedChars=N limitChars=20000]`，不再静默截断。
10. **新 hint**：`no space with id`、`only removes user-owned`、`matches N spaces`、`could not be read|could not be verified` 等失败都带下一步建议。

## 行为变化（0.1.9）

0.1.9 让失败结论也有实测依据，因此有三处会直接影响调用方式的变化：

1. **动作可能「转换成功之后仍返回 `ok:false`」**：`close`/`finish`/`complete`/`mark_error`/`handoff`/`wait_control` 都会轮询回读真实状态（12×150 ms，约 2.4 s）。动作本身可能已经落地，但状态在轮询窗口内没到位 → 仍返回 `ok:false`。看到 `ok:false` 先读 `error` 里的实测状态（`observed ownership=…`、`was still listed after … ms`）和 `hint`，**不要盲目重试**：先用 `ego_app_space{action:'list'}` 确认现状，空间已经不在就说明动作其实生效了。
   **任务结束导致输出被丢弃（新兜底）**：ego 在「动作触发的任务结束」时会 hard-stop 脚本并**丢弃已缓冲输出**（连结果哨兵一起丢），CLI 只打印 `This task space is no longer assigned to the agent: its task has ended … browser commands are paused` 并以 0 退出。旧版会把这种**其实已经成功**的 `close` 报成「脚本没跑」。现在 `ego_app_space` 的 `close`/`finish`/`complete`/`mark_error`/`handoff`/`wait_control`/`takeover` 命中该通知时，会用一次独立的只读 `listTaskSpaces()` 复核再下结论（只在「命中通知且原本判失败」时触发，正常路径仍返回 ego 原生回执）：终结类动作可能返回 `{ok:true, …, receipt:null, verifiedBy:"listTaskSpaces", note:"…"}`——**`receipt:null` 不是失败**（回执被 ego 丢了，结论来自独立复核；`finish` 在该路径上 `keep` 也是 `null`）；空间不在列表 → `ownership:"closed"`，仍在列表但 `ownership` 是 `user` → 对 `finish(keep:true)`/`complete`/`mark_error` 也算成功。`handoff`/`takeover`/`wait_control` 若复核到**目标态已经达成**（分别是 `agentDelegatedToUser`/`agent`/`agent`）同样返回 `ok:true`（`handedOff`/`tookOver`/`control` + `verifiedBy`），不会因为脚本没跑完就把已达成的状态判失败；空间已消失时这三个仍失败。**按 name 寻址且空间已消失时，兜底结果的 `spaceId` 是 `null`**（插件拿不到 id；只有按 id 传入时才回显）——`spaceId:null` + `verifiedBy:"listTaskSpaces"` 是成功，不是缺字段。两个例外：`finish{keepPages:[...]}` 命中该通知时**不走兜底**（page 级结果无法用空间列表验证，保留原始失败）；`finish(keep:false)` 在这条路径上若空间仍以 `user` 列出则**失败**（要关掉却没关掉，hint 指向按 id `delete` 或面板关闭）。
2. **除 `open` 外的空间动作不再创建空间**：官方 `taskSpace(name)` 是「reuse **or** create」，所以旧版「close 失败 → 重试 close」会静默新建同名空间再关掉、返回假成功。现在只有 `open` 会创建；`close`/`finish`/`delete` 等在名字或 id 不存在时直接报 `… is currently open. This action only operates on an existing space; it never creates one.`。**空间动作（含 `open`；`list`/`create` 除外）必须显式给 `name` 或 `id`**——空白 name（如 `"   "`）等同于缺省——否则宿主侧直接报 `name (string) or id (number) is required for this action`（附 hint、零副作用）——这是故意的安全设计，避免误关/误改最新空间；只有 page 工具（`ego_app_navigate`/`snapshot`/`click`/`fill`/…）可以省略 name，取最新的 agent 空间（没有则取最新的 `agentDelegatedToUser` 空间）。
3. **「空间已消失」统一记作 `"closed"`**：对 `close`/`finish`/`complete`/`mark_error` 算成功（`ownership: "closed"`），对 `handoff`/`wait_control`/`takeover` 算失败（它们需要一个仍然存在的空间才能达成目标状态）。终结类动作不会再在空间已被别处关闭时「真空通过」。

另外几处属于能力/口径修正：

- **`timeoutMs` 是整次调用的预算**：`download`/`file_chooser`/`wait_event`（含 `ego_app_page` 的同名动作）从「arm 等待器 → 点击 trigger → 等待事件」全程共用一份 `timeoutMs`，trigger 点击拿的是剩余预算（下限 500 ms），不再是点击与等待器各花一份。`wait_control` 的 `timeoutMs` 会 clamp 到插件级预算内（`config.timeoutMs - 5000`；默认配置下有效上限 175 s、不传该参数时默认 165 s），结果里带 `requestedTimeoutMs`/`timeoutMs`/`clamped`，告诉你实际等了多少。
- **`ego_app_run` 的纯文本超限不再算失败**：输出超过 `maxOutputBytes` 时仍是 `ok:true` + `truncated:true`（0.1.8 会报 `ok:false`）；`maxOutputBytes` 按 UTF-8 字节计，中文不会再约到 3 倍才触发。
- **locator 支持范围**：`ego_app_click`/`ego_app_fill` 接受 `@N`/`ref=`/`text=`/`loc=css|role|href:`/`xpath=` 与纯 CSS，也接受 `css=`、`>> nth=N`、`:has-text(...)`/`:text-is(...)`/`:text(...)`——后几类交给 ego 自己的 locator 解析，不会被硬塞进 `document.querySelector`；trigger 预滚动与 `mouse_click` 的纯 CSS 目标也会先把元素滚进视口，`mouse_click` 点击后还会**恢复原视口位置**（不会把页面留在滚动后的位置）。`ego_app_pointer{mouse_click}` 只接受 x/y 或**一个纯 CSS 选择器**（可带 `css=` 前缀），ref/loc=/xpath=/text=/`>>` 会得到可读拒绝。
- **`delete` 的回执与失败语义**：删除后轮询回读，`stillListed` 非空或 ego 回执里 `skippedRunningSpaceIds` 非空现在都**报错**（不再 `ok:true` + 报告了事）；结果带 `deletedIds`/`stillListed`/`skippedRunningSpaceIds`/`receipt`；`id`（单数）与 `scope:"task"` 可用，`scope:"all"` 明确拒绝。更严格的：`force:true` **不能**绕过 agent-owned 目标——仍是 `ok:false`，错误里写明 `force:true cannot make ego delete…`；`ids` 里有不存在的 id 会点名；按 `name` 命中多个空间会报错并要求改传 `ids`。
- **`finish`/`complete`/`mark_error` 透出 ego 回执**：`finish` 的结果里 `receipt` 带 `closedSpace`/`keptManagedLabels`/`closedManagedLabels`/`preservedUnmanagedCount`，`complete`/`mark_error` 的 `receipt` 是 ego 的原话字符串——它们与实测 `ownership` 一起构成「真的做完了」的证据。
- **读数失败 ≠ 空间消失**：`listTaskSpaces()` 返回错误对象或缺少 `taskSpaces` 时，`close`/`finish`/`complete`/`mark_error` 不再把它当「空间已关闭」报成功，而是**报失败**，`error` 里带 `observed ownership: unreadable`（hint 指向先 `list`/`ego_app_status` 再重试）；兜底探针读失败会放弃兜底、保留原始错误。**看到 `unreadable` 表示状态没能确认——既不是成功，也不是「已完成转换」**。
- **失败 hint 有优先级**：具体观测（`task has ended`、`unreadable`、实测 `ownership`）的 hint 会覆盖泛化的「检查安装 / 完成 onboarding」提示，按实际状态处理。

## ego 语义边界（实测，已被工具显式处理）

1. `task.finish({ keep })` 只接受 `"all"` 或页码数组 → 工具映射为 `keep: true/false` 或 `keepPages: ["p1"]`，并预校验标签是否存在。
2. `handoff`/`takeover` 后控制权在用户，浏览器命令会被硬暂停 → 返回带 `hint` 的错误，指向 `wait_control`。
3. `ego.createTaskSpace()` 之后必须 `useTaskSpace(id)` 才成为工作空间 → `create` 已内建。
4. 新建空间没有 `p1` → 页面前导自动 `newPage()`。
5. `mark_error` / `complete` 结束任务、归属翻回 `user`；同名 `open` 会返回结构化提示（附 id，建议 `claim` 或换名）。
6. `deleteSpaces` 只删 user-owned；传 agent-owned 会挂起到超时 → `delete` 先查归属并给可读错误。0.1.9 起还会轮询回读：`stillListed` 非空、或回执里 `skippedRunningSpaceIds` 非空都直接报错（附 hint）；结果带 `deletedIds`/`stillListed`/`skippedRunningSpaceIds`/`receipt`；支持 `id`（单数）与 `scope:"task"`，`scope:"all"` 明确拒绝。更严格：`force:true` 不能绕过 agent-owned 目标（一律 `ok:false`，错误含 `force:true cannot make ego delete…`），`ids` 里不存在的 id 会点名，按 `name` 命中多个空间会报错要求改传 `ids`。`delete` 不依赖空间前导，没有 agent 空间时同样可用。
7. **`agentDelegatedToUser` 空间（交还控制后）没有 API 能关闭**：`closeTaskSpace`/`claimTaskSpace`/`deleteSpaces` 均返回成功但不生效。需在 ego 面板手动关闭，或让用户先交还控制。**0.1.9 起 `close` 会轮询空间列表**（12×150 ms，约 2.4 s）直到 id 消失：正常关闭不再被误报成失败；只有 ego 明确拒绝（回执带 `error`，如空间已委派）、轮询后仍列出、或列表读不出来才 `ok:false`（读失败时错误带 `observed ownership: unreadable`，不会被当成「已关闭」），错误里带实测 `ownership` 与 hint（不再断言「这是委派给用户的空间」）。别用「重试 close」当解法——除 `open` 外的动作不会创建空间，重试只有在空间确实还在时才有意义。
8. `ego_app_dialog` 的 `trigger` 参数在同一调用内点击并应答，`handled` 取真实返回值（跨调用的行为见第 14 条）。
9. `page.fetch` 受浏览器 CORS 约束；`page.waitForEvent` 只支持 `popup` / `download`。
10. agent 自己建的页面不能 `release`（只能 `close`）；用户页才需要 `adopt`。
11. `takeover` 的官方 API 是 `takeOverTaskSpace(spaceId)`，**必须带 id**；无参调用不切控制权却也不报错。工具现已按 id 调用并回读 `ownership` 校验。已 `finish` 且保留了页面的空间无法 `takeover`，只能 `claim`（需用户同意）。
12. `drag` 走原生 HTML5 拖放：**源元素必须 `draggable="true"`**，否则 `page.dragAndDrop()` 返回成功但页面没有任何事件（工具层看不出来，用 `ego_app_js` 回读真实状态验证）。
13. onboarding 未完成时 CLI 打印提示并**以退出码 0 退出**，不执行脚本也不产出结果 → 工具据此判定为失败并给出 hint，不会返回 `{ok:true, data:null}`。
14. `receipt.dialog` 报出的对话框必须**紧接着**用 `ego_app_dialog` 应答：实测 0.6.2.5 里未应答的对话框会跨调用残留，该页后续每轮都会超时（`ego_app_js` 报 `PageEvaluationTimeoutError`，约 15 s；guide 的"跨轮自动关闭"在此版本不成立）。
15. 下载必须在**同一脚本内** `saveAs()`：临时文件随该轮结束删除 → `ego_app_download` 已内建。
16. **ego 默认动作超时（约 3 s）对远在视口下方的元素不够用**：同一元素默认超时报 `element is not visible in the viewport`。实测在仓库自带 fixture 上：默认失败（3.0 s）→ `timeoutMs:8000` **仍然失败**（8.2 s）→ `15000` 通过（约 11.7 s）→ **先 `scrollIntoView` 再用默认超时通过（0.36 s）**。所以正确做法是「预算 ≥ 15 s」或「先把目标滚进视口」，不要照抄 8000。`timeoutMs` 不是每个工具都有：**支持** `click`/`fill`/`navigate`/`wait`/`wait_control`/`file_chooser`/`download`/`wait_event`（后三个是整次调用的总预算，见上节），0.1.10 起 `ego_app_page{action:'reload'|'focus'}` 也透传该值（`close` 没有参数）；`pointer` 没有该参数；显式 `<= 0` / 非有限值会被直接拒绝（见 0.1.10 第 3 条）。
17. **文件选择器只在用户激活的点击下打开**：ego 遇到需要先滚动进视口的元素时会退化成程序化 `element.click()`，Chromium 因此不弹选择框。工具已对**纯 CSS 或 `css=` 前缀**的 trigger 先 `scrollIntoView` 再点击来保住真实输入；`@ref` / `loc=` / `xpath=` 的 trigger 无法预滚动，长页面上请先用 `ego_app_js` 滚进视口再调用。

## 与官方 skill 的关系

ego 官方推荐形态是 Agent Skill（`~/.agents/skills/ego-browser/`）+ `ego-browser nodejs` 脚本，没有 MCP。本插件不替代它，只是把同一条 CLI 包成结构化工具，省 token、带校验；需要复杂流程时用 `ego_app_run` 写完整脚本，与官方写法一致。

## 测试

0.1.10 的实跑状态：`npm test` **48/48**、`live-e2e` **89/89**、`pointer-selector` **11/11**（2026-11-01，见 [run log](docs/TEST-RUN-2026-11-01-0.1.10.md)）。

- `npm test` —— 不需要 ego lite，48 项纯函数回归：`test/cli-outcome.test.mjs`（21 项：onboarding 预检、无哨兵、坏哨兵、非零退出、截断与 UTF-8 字节预算、哨兵 token）、`test/output-collector.test.mjs`（6 项：字节计数/截断/解码，字段 `text`）、`test/locator-detect.test.mjs`（5 项：`plainCssFrom` 对 `css=`、引号内的 locator 标记、各类 ego locator 的判定）、`test/ended-task-outcome.test.mjs`（16 项：`decideEndedTaskOutcome` 判定表，含 0.1.10 补齐的 `name`/`keep`/`requestedTimeoutMs` 等字段）。
- `npm run test:live` —— 需要 ego lite 在运行、已完成 onboarding：
  - `test/live-e2e.mjs`（89 项）：动作回执、下载落盘、文件选择器、子树快照、富粘贴、指针右键，以及 0.1.9 的 `close` 轮询/重试不新建空间/回读语义，和 0.1.10 的 fail-closed 读失败、`pageCreated`、`ego_app_js` mode、`wait{for:'function'}` 完整函数、`timeoutMs` 卫生、abort、nonce 伪造等。
  - `test/pointer-selector.mjs`（11 项）：`mouse_click` 只接受 x/y 或纯 CSS 选择器，ref/loc= 必须报错而不是点 (0,0)。

0.1.10 的实测记录见 [docs/TEST-RUN-2026-11-01-0.1.10.md](docs/TEST-RUN-2026-11-01-0.1.10.md)；历史日志：
[docs/TEST-RUN-2026-11-01-0.1.9.md](docs/TEST-RUN-2026-11-01-0.1.9.md)（0.1.9）、
[docs/TEST-RUN-2026-10-31.md](docs/TEST-RUN-2026-10-31.md)（0.1.1–0.1.3）、
[docs/TEST-REPORT.md](docs/TEST-REPORT.md)（0.1.0 时代的 19 工具报告：正文 95/95、附录 A.3「99 项」是历史口径，**不是当前套件的计数**）。

测试页在 `test/fixtures/interaction.html`（带点击坐标捕获），可用 `EGO_E2E_FIXTURE` 指向别处；
ego lite 未运行时两个 live 套件会打印 SKIP 并以 0 退出；CI 里设 `EGO_E2E_REQUIRE=1` 则改为失败退出。
注意参数校验的两种错误形态：`ego_app_download` 缺 `saveAs` 由宿主直接抛 `ToolArgsError`（schema 必填），
其余工具的错误都以 `{ok:false, error}` 返回。

## 许可

MIT。ego lite 本体（Citro Labs）不在本仓库内，也不随本包分发。
