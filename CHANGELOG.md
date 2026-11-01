# Changelog

## 0.1.7 — 2026-11-01

收掉第四轮审查提出的四处残留（均不影响主流程）。

- **R-a**：`saveAs` 传空串/空白字符时，schema 的 `required` 只查存在性，会一路走到 ego 抛裸
  `TypeError: download.saveAs requires an absolute file path`。现在 `execute` 先 `trim()` 校验，
  返回人话：`saveAs must be a non-empty absolute path, for example C:/Users/me/Downloads/report.pdf`。
- **R-b**：滚动恢复原来只记 `window.scrollY`，覆盖不到 `scrollIntoView` 连带滚动过的
  `overflow:auto` 祖先。现在记录**所有可滚动祖先**的 `scrollTop/scrollLeft`（连同文档滚动位置）再逐个恢复，
  实测嵌套面板 `scrollTop` 212.8 → 0。
- **R-c**：恢复动作不再夹在"点击失败"与"抛错"之间——`__clickError` 存在时跳过恢复，
  避免点击弹出阻塞对话框时先吃 15 s evaluate 超时、把回执延后约 18 秒。
- **R-e**：live 用例修正——"等待器提前过期"改为用**不开选择框**的 trigger（`#target`），
  这样走的是 arm-time `.catch` 路径而不是"click 取消 chooser"路径；回执形状检查改用可见元素的 click
  （原用例填视口外的 `#editable`，ego 的 fill 滚不到，属于用例自身的脆弱）。
  两个 live 套件新增 `EGO_E2E_REQUIRE=1`：应用没跑时不再静默 SKIP，而是 **exit 1**，CI 里能变红。
- **R-d 行为变化记录**（非本轮引入，补文档）：
  - `ego_app_page{action:'wait_event', event:'popup'}` 超时由"返回 `popup:null`"改为**报错**（0.1.3 起）。
  - `ego_app_download` 缺 `saveAs` 由宿主抛 `ToolArgsError`（0.1.5 起，schema 必填），其余 19 个工具仍是 `{ok:false,error}`。
- 测试：`live-e2e` **34 项**（+2：嵌套滚动容器恢复、空 `saveAs` 可读报错）。

## 0.1.6 — 2026-11-01

修复 0.1.5 核验报告里的 3 个问题。

- **等待器提前 reject 会绕过整段修复。** `try { chooser = await chooserPromise }` 只包住"取结果"，
  而等待器在 `waitForFileChooser()` 调用时就启动；`timeoutMs` 设得很短时它会在脚本走到 try 之前 reject，
  Node 按 unhandled rejection 处理直接杀进程 → 回执与提示全部丢失（`timeoutMs:1` 实测：裸超时、无回执）。
  现在**在 arm 时就挂 `.catch(e => ({ __error: e }))`**，之后分支处理；`download` / `wait_event(popup|download)`
  同样处理。trigger 点击自己抛错时也会带上回执与新提示（"trigger click itself failed … retry with a larger timeoutMs"）。
- **防御性 CDP 清理不再可能盖掉回执。** 原来 `await page.cdp(...)` 无超时且跑在 `throw` 之前，CDP 不回时
  调用方只会看到插件级 180 s 超时。现在**先构造 Error**，清理调用带 `{ timeout: 3000 }` 并吞掉自身错误。
- **预滚动会把页面留在下方。** 0.1.4 给纯 CSS trigger 加了 `scrollIntoView`，但点完不回来 → 之后点页面顶部元素
  即使 `timeoutMs:9000` 也失败（ego 向上自动滚动不可靠）。现在 trigger 点击前记下 `window.scrollY`、点击后恢复
  （实测 380 → 380，且随后点顶部元素正常）。`ref=`/`loc=` trigger 不做预滚动，因此不受影响。
- 文档/测试：`test/live-e2e.mjs` 新增 3 项（提前过期仍带回执 / 滚动位置恢复 / 滚动后顶部元素可点），共 **32 项**；
  live-e2e 在 ego lite 未运行时也打印 SKIP 并退出 0（README 的说法现在两种套件都成立）；
  补充说明 `saveAs` 缺失由宿主抛 `ToolArgsError`，其余工具仍返回 `{ok:false,error}`。

## 0.1.5 — 2026-11-01

修复 0.1.4 核验报告里的 2 个 file_chooser 残留问题 + 3 处描述/测试缺口。

- **R1 修复：`file_chooser` 超时丢回执。** 0.1.4 的 CHANGELOG 说 chooser 与 download 都带回了点击回执，
  实际只改了 download（chooser 的 await 没包 try/catch）——本版本补上。现在点击一个只弹 alert 的 trigger，
  报错是：`page.waitForFileChooser timed out … | click receipt: {"dialog":{"type":"alert","message":…}}
  | the click opened a dialog (alert): answer it with ego_app_dialog{action:'accept'} …`。
- **R2 定性并处理：超时后页面"打不开选择框"的真正原因是那个未被应答的对话框，不是拦截残留。**
  实测：alert 触发 → chooser 超时 → 页面被弹窗挡住，后续每次 `waitForFileChooser` 都超时；
  `ego_app_dialog{action:'accept'}` 之后**立即恢复**。另测三条路径（点击不开选择框 / 选择框晚于超时打开 /
  1 ms 超时）**都未复现**永久污染，所以没有引入 `page.close()` 之类的自毁式回收。
  处理：超时时按回执分流给出指引（有 dialog → 叫你先应答；没有 → 重试/换页），
  并额外发一次 `Page.setInterceptFileChooserDialog {enabled:false}` 作为兜底清理（实测不影响后续选择框）。
- **R3**：`ego_app_pointer` 描述补上它其实会返回 `receipt`。
- **R4**：`trigger` 参数描述写明"只有纯 CSS 会被预滚动；ref/loc= trigger 在长页面上可能打不开选择框"。
- **R5**：`ego_app_download.saveAs` 改为 schema 级 `required: true`（`dsh-tools` 支持逐属性声明），
  缺少参数时由宿主直接拒绝：`invalid arguments: missing required property "saveAs"`。
- **测试**：
  - `live-e2e` 新增 3 项（超时带回执 / 提示指向 ego_app_dialog / 应答后 chooser 恢复），共 **29 项**；
    原"dialog 不是双层嵌套"断言改为诚实的 shape guard（该 fixture 不会触发上传对话框）。
  - `test/pointer-selector.mjs` 在 ego lite 未运行时打印 SKIP 并退出 0，可安全放进 CI。
  - `package.json` 新增 `npm run test:live`（live-e2e + pointer-selector），README 说明 `npm test` 与它各自覆盖什么。

## 0.1.4 — 2026-11-01

修复 0.1.3 引入的 1 个高危缺陷 + 核验报告里的字段/描述/超时问题。

- **高危修复：`ego_app_pointer{mouse_click}` 静默点到 (0,0)。** 0.1.3 会把 `@N`/`ref=`/`loc=`/`xpath=`
  判定为"非纯 CSS"后**清空并按 `x??0,y??0` 点击**，返回 `ok:true` —— 而 (0,0) 是真实可点位置。
  现在这类选择器**直接报错**并指向 `ego_app_click{selector, button}`；`selector` 与 `x/y` 同时给也会报错；
  `mouse_click` 只接受 x/y 或一个纯 CSS 选择器，两者都没有则报错。`action` 拼错不再回落到坐标点击。
- **`file_chooser` 结果字段修复**：`multiple` 改用官方 `isMultiple()`（之前读不存在的 `.multiple`，恒为 null）；
  `dialog` 不再双层嵌套。
- **文件选择器在长页面上打不开**：ego 需要滚动时退化为程序化 click，Chromium 不弹选择框 →
  file_chooser / download / wait_event 对**纯 CSS** trigger 先 `scrollIntoView` 再点击。
- **错误路径不再丢回执**：chooser / download 超时抛错时，错误信息里带上点击回执（能看出是不是被 alert 挡住）。
- **`fill` 支持 `timeoutMs`**；`file_chooser`/`download`/`wait_event` 的 trigger 点击也透传该超时；
  `wait_event` 未给超时时默认 30 s（此前不发 options，会挂到插件级 180 s）。
- **描述修正**：`ego_app_dialog` 不再声称"跨调用自动关闭"（实测相反：未应答对话框会卡死后续每一轮）；
  `click`/`fill`/`key`/`select`/`pointer`/`upload`/`download` 的描述里说明会返回 `receipt`。
- **回执语义**：API 没给回执 → 省略该键；给了但没有 popup/dialog → `{}`（不再一律 `null`）。
- **`page` 未知 action 报错**（不再静默 `reload`）；`snapshot` 未知 `scope` 报错、非 subtree 传 `root` 报错、
  回显 `scope: "viewport"` 而不是内部值 `only_within_viewport`。
- 测试：`test/fixtures/interaction.html`（带点击坐标捕获）入库，`live-e2e` 改用仓库内 fixture，
  `EGO_E2E_FIXTURE` 可覆盖；下载落到系统临时目录。新增 `test/pointer-selector.mjs`（11 项）锁定本次高危缺陷。
- 文档：README 语义边界补第 16/17 条（约 3 s 默认超时不够用、文件选择器需要用户激活的点击），
  并修正第 14 条的错误名（`PageEvaluationTimeoutError`，不是 `PageDialogOpenedError`）。
  更正 0.1.3 条目里"没有不兼容变更"的说法：`file_chooser` 的结果字段与 `wait_event` 的 `popup` 改名属于行为变化。

## 0.1.3 — 2026-11-01

补 bug 版：按官方 guide v2.2.0 补齐四类"官方有、工具拿不到"的缺口（独立调查员报告逐条核验通过）。没有不兼容变更，全部是新增可选参数 + 一个新增工具。

- **动作回执（action receipts）不再丢弃**：`page.click/fill/press/selectOption/dblclick/hover/dragAndDrop/setInputFiles`
  的返回值现在会被序列化成 `receipt: { popups?: [{label,targetId}], dialog?: {type,message,defaultPrompt} }`
  一并返回。点开新页/弹出对话框当场就能看到目标，不必再"点两次"兜底。
  实测 0.6.2.5 的 `receipt.dialog` 是普通对象（`{type,message,...}` 属性），不是方法，已同时兼容两种形态。
- **下载接通**：新增第 20 个工具 `ego_app_download`（先 arm `waitForEvent(download)`，再点 trigger，最后 `download.saveAs()`；
  返回 `saved`/`suggestedFilename`/`url`）。`ego_app_page{action:'wait_event', event:'download'}` 也支持 `saveAs`，
  不再把事件对象 `String()` 掉；`event:'popup'` 返回 `{label,targetId}` 而不是字符串。
- **文件选择器可落文件**：`ego_app_page{action:'file_chooser'}` 支持 `trigger`（先 arm 再点击）与 `files`
  （传给 `chooser.setFiles()`），并回传上传触发的 `dialog`。
- **`snapshot` 子树**：`ego_app_snapshot{scope:'subtree', root:'@12'}` 聚焦 iframe 子树（`root` 必填校验）。
- **富文本粘贴**：`ego_app_key{action:'paste', html:'<table>…'}` 走官方 `keyboard.paste({text, html})`。
- **`adopt` 支持 `{as}`**：`ego_app_space{action:'adopt', as:'name'}`。
- **修 bug**：`ego_app_pointer` 的 `button` 之前不在 schema 里，right/middle **永远传不进去**；现在已声明，
  `mouse_click` 还支持用纯 CSS 选择器点击元素中心，`down`/`up` 也补进 action 说明。
- 文档：新增实测语义——`receipt.dialog` 报出的对话框**必须立刻用 `ego_app_dialog` 应答**，
  否则该页后续每一轮都会被 `PageDialogOpenedError` 挡住（0.6.2.5 实测，与 guide 的"跨轮自动关闭"不完全一致）。

## 0.1.2 — 2026-10-31

修复实测发现的 3 个 bug，并补上 first-class 回归测试（`npm test`，9 项）。

- **修复：onboarding 未完成时静默成功。** ego lite 首次启动、引导未完成时，`ego-browser` CLI 只打印
  `Please complete the onboarding process first…` 并**以退出码 0 退出**，不执行脚本、不产生
  `@@DSH_RESULT@@`。旧实现把「退出码 0 且无哨兵」当成功，于是 `ego_app_status` 返回
  `{ok:true, data:null}`。现在统一由可单测的纯函数 `interpretCliOutcome()` 判定：已知预检文本 →
  `ok:false` + 可执行 hint；结构化工具「退出码 0 但无哨兵」→ `ok:false` 而不是 null；哨兵 JSON 损坏 →
  `ok:false`。`ego_app_run` 的纯文本输出行为保留，但 onboarding 预检优先，不会被当成成功吞掉。
- **修复：`ego_app_space{action:"takeover"}` 假成功。** 旧实现调用 `ego.takeOverTaskSpace()`
  **不传 spaceId**，返回值还硬编码 `tookOver: true`；实测交还控制后调用它，ownership 仍停在
  `agentDelegatedToUser`，下一条浏览器命令继续被暂停。官方语义是
  `const task = await takeOverTaskSpace(spaceId)`，现已按 spaceId 调用并**回读 ownership 校验**，
  失败时给出可读原因和 `claim` 出路。
- **修复：`delete` 的两个误导。** 删除后立刻 `listTaskSpaces()` 拿到的是旧快照（ego 异步刷新），
  现在短暂轮询直到 id 消失，返回 `{ deletedIds, stillListed }`；目标不存在时的报错从
  `nothing matched: pass ids…` 改为说明「该 id 可能已关闭或删除，用 list 确认」。
- 其他：`ego_app_gesture` 把 ego 返回的人话字符串从 `shown` 拆到 `detail`，`shown` 恢复布尔值；
  `close` 补进 action 枚举描述；失败结果统一携带 `hint`/`output`。
- 文档：`ego_app_run` 示例补上 `await taskSpace(...)`（官方 API 返回 Promise）；补充 `drag`
  走原生 HTML5 拖放的限制（源元素需 `draggable=true`，否则 `ok:true` 但没有效果）。

## 0.1.1 — 2026-10-31

- 修复：`package.json` 带 UTF-8 BOM，导致 DSH 插件校验解析 JSON 失败（`dsh plugin add` 报 `SyntaxError: Unexpected token '﻿'`）。**0.1.0 无法被 DSH 安装，请使用 0.1.1。**

## 0.1.0 — 2026-10-31

首个公开版本。

- 19 个 `ego_app_*` 工具，覆盖 ego lite agent 控制面：app 级（版本/Space/标签/profile/手势/CDP）、TaskSpace 生命周期、Page 操作（导航、快照、截图、点击、填表、键盘、指针、下拉、等待、求值、CDP、对话框、上传、文件选择、fetch、事件）。
- 通过官方 `ego-browser nodejs` 执行：脚本写入 UTF-8 `.mjs`，用 `-e "await import('file:///…')"` 入口，避免 shell 引号与编码问题。
- 结果走 `@@DSH_RESULT@@` 哨兵解析（ego 的 `console.log` 走 stderr，双流扫描）。
- 所有返回对象经 `lossless()` 过滤 undefined，避免宿主拒绝非无损 JSON。
- 显式处理 ego 语义边界：`finish` 的 `keep` 形态、交还控制后命令暂停、`createTaskSpace` 需 `useTaskSpace`、新建空间无 `p1`、`deleteSpaces` 只删 user-owned、delegated 空间不可程序化关闭、对话框需同调用内应答。
- 99 项测试矩阵通过（含会话内实测）：页面交互、等待、CDP、对话框、Space 生命周期、交还控制。
