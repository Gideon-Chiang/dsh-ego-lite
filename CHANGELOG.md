# Changelog

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
