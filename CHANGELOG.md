# Changelog

## 0.1.15 — 2026-11-01

重构：**删掉手写词法扫描器，改用「引擎 parser 当 oracle + value probe」**，并修掉重构后暴露的真缺陷（本轮由 Lead 在用户重构之上完成）。

- **设计**：`parsesAsExpression(src)` 只用 `new Function("return (src
);")` 编译（不执行），注释/正则/生成器语法由 V8 裁决；`valueProbe(src, withArg)` 求值后**仅当结果是函数才调用**。`ego_app_wait{for:'function'}` 的谓词与 `ego_app_js` 的 auto 值模式都用 probe——"函数源码被当 truthy 表达式 → wait 首轮假通过"从根上消失。`syntaxProblem` 的包装加 `NL`，尾部 `//` 注释放不再吞掉 `);`。
- **尾分号**：`trimSource` 只做 trim + 去尾分号（不是词法分析）——`{expression:"1+1;"}`→2、`{expression:"() => 1;"}`→1、`fn:"(x)=>x+1;"`+`arg`→42、`wait{expression:"() => 1;"}` 可执行。
- **空源码**：`ego_app_js{}`、`{expression:""}` 以及**只含空白/分号/注释**的源码（`;`/`;;`/`; ;`/`; // c`/`/*c*/;`）明确报 `expression is required`；`wait{expression:";"}` 报 `expression is required for for="function"`（以前静默 `evaluate(() => undefined)`）。
- **函数值不再静默丢（含 async/Promise）**：显式 `mode:"expression"`、`mode:"function"`（函数返回值）、`mode:"statements"`（体内返回函数）以及 auto 的 probe 统一标记 `{ value: null, valueType: "function", note: … }`；四个外壳都改为 **`async` 并在 `await` 之后判断**，auto 的非函数分支也 await，所以 `async () => () => 1`、`() => Promise.resolve(() => 1)`、`Promise.resolve(() => 1)`、`(async () => () => 1)()` 都不再静默丢（auto 的行为是调用函数，见下）。**副作用**：`statements` 体型现在支持**顶层 `await`**（以前是语法错误），所有模式的 Promise 都会被 await/flatten。
- **包装逃逸在 spawn 前拒绝**：新增**双包装 oracle**——同一源码必须同时通过 `(src)` 与 `[src]` 两种编译；`js{expression:"1); evil(); (2"}` 这类"关闭括号后写语句"的来源得到可读错误且**零 spawn**（"Nothing ran" 承诺成立），`wait` 同样。
- **语义**：`js` auto = 求值，结果是函数则**调用**（`() => 1+1`→2、`() => ({a:1})`→对象）；`mode:"expression"` **绝不调用**；`mode:"function"`/`fn:` 调用（单参 `arg`）；`mode:"statements"` 当函数体执行；`wait` 谓词 = probe（求值，函数则调用）。
- **已知限制（宣布不修，不是待办 BUG）**：(A) 刻意构造同时满足两种包装的源码理论上仍可绕过 oracle——源码由调用方/模型提供，等价于 `ego_app_run`，彻底消除需引入 JS parser 依赖，本项目不引入；(B) `js` auto 会调用函数值——生成器调用返回 truthy 迭代器（wait 立即满足），`class A {}` 被调用会抛 `Class constructor cannot be invoked without 'new'`，要"只取值不调用"用 `mode:"expression"`；(C) 其余既有 S3：结构化 `log` 上限 16000（`logLength` 为 UTF-16 字符数）、非字符串 label 原样进结果、`id:0` 是真实空间、上游/环境项。
- **移除导出（patch bump 需知）**：公开导出 `isFunctionSource` 随重构移除；若外部代码 import 它请改用行为契约（`wait`/`js` 的 probe 语义）。测试 `test/function-source.test.mjs` 一并删除，覆盖并入 `test/generated-scripts.test.mjs`（P1–P13：尾分号、分号/注释空源、双包装拒绝、显式表达式/statements/function 的函数值标记、async 函数值标记、auto 的 Promise→函数标记、auto 调用函数值、wait 谓词真超时、空源守卫线性度回归）。计数见下方 gate 行。
- 测试（最终 gate，2026-11-02 00:17:24–00:19:25）：`npm test` **121/121**、`live-e2e` **89/89**、`pointer-selector` **11/11**（跑前/跑后 sha 均 `cf102529…`）。

## 0.1.14 — 2026-11-01

收掉 0.1.13 残留的最后两条 N4 词法边缘（N4-a/N4-b），其余行为不变。

- **N4-a 跳过注释**：`isBareFunctionSource` 的扫描器新增 `skipComment()`——`//` 跳到行尾、`/* … */` 跳到闭合；注释里的 `}`/`)`/引号不再打断函数源码识别。`(x) => { // note
 return x; }`、`(x) => { /* } */ return x; }`、`(x) => x /* ) */ > 0` 现在都判为函数源码（以前被归成 expression、包成 truthy 箭头 → `wait{for:'function'}` 首轮假通过）。**注释等同空白**：跳过注释但不改变词法状态，`return /*c*/ /}/.test(x)`、`(a = /*c*/ /[)]/…) => a`、`(a) => a + /*c*/ /[)]/` 也都是函数源码；头部注释（`function /*c*/ f(){}`、`async /*c*/ () => 1`、`function* /*c*/ g(){}`）同样支持；`function` 与生成器的 `*` 之间也允许注释（`function /*c*/ * g() {}`、`async /*c*/ function /*c*/ * g() {}` 都判为函数源码）。生成器 `function*` 分类正确，但用作 `wait{for:'function'}` 谓词时调用返回 truthy 迭代器 → 立即通过，属 JS 语义；需要布尔谓词请用非生成器函数。
- **N4-b 关键字后的 regex**：新增 `REGEX_KEYWORDS`（`return`/`typeof`/`instanceof`/`case`/`yield`/`await`/`delete`/`void`/`in`/`of`/`new`/`do`/`else`/`throw`）与 `regexPosition()`，并用 `trackChar()` 维护「上一个非空白字符 + 当前标识符 + 空白间隔」状态——关键字之后的 `/…/` 被当作 regex 跳过（`(x) => { return /}/.test(x); }`、`(x) => typeof /}/.test(x)` 现在判为函数源码）。
- **不变**：调用表达式 `(async()=>1)()`、`(0,()=>7)()`、`function(){}()`、`((a)=>a)` 仍按 expression；字符串/模板里的 `//`、括号、`/` 不受影响（先 `skipQuoted`）；除法 `a / 2`、`a++ / 2`、`a && /x/.test(a)` 仍正确；解析层 `new Function("return (src);")` 仍是最终门槛（只编译不执行）。 仍保留的极窄边界：语句位 `)`/`}` 后的 regex（`if (x) /}/…`）、文件尾 `//` 无换行（js 路径给可读错误）、`async => 1`（`(a /* ) */) => a` 现在为 true，不属于残余）。
- **文档**：README 中英新增 0.1.14 行为节；0.1.13 run log 的「已知残余」移除 N4-a/N4-b（已在本轮修复）；新增 `docs/TEST-RUN-2026-11-01-0.1.14.md`。
- 测试（最终 gate，2026-11-01 22:11:45–22:13:42）：`npm test` **126/126**、`live-e2e` **89/89**、`pointer-selector` **11/11**（0.1.13 届时套件为 112/89/11；按本轮 126 项套件回看为 118/126）。

## 0.1.13 — 2026-11-01

收掉 0.1.12 审计记的 5 条 S3 follow-up（用户点名全修）：N4/N6/N7/N9/N2①。

- **N4 `isFunctionSource` 改为括号匹配**：删除形状正则，新增 `isBareFunctionSource()`（按括号/花括号配对、跳过引号与模板字符串的 `${…}`）。参数里带嵌套括号的箭头（`(x = foo()) => x > 0`、`(a = (1)) => a`）现在被正确识别为函数源码——以前 `wait{for:'function'}` 会把它们包成 `() => (…)`，箭头本身 truthy 导致**首次轮询即假通过**；现在必须等到真实条件。0.1.13 起这四类也**全部按表达式处理**（整段必须恰好是一个函数表达式）：`(async () => 1)()`、`(0, () => 7)()`、`function(){}()`、`((a) => a)`——其中 **`function(){}()` 在 0.1.12 旧版曾判为函数源码**，另外三个旧版本来就是 expression（不是「两版都 false」）。正则字面量里的括号也不会被误判（`(x) => /\)/.test(x)` 中 `/` 被识别为 regex，跳过 `[...]` 字符类与转义）。
- **N6 轮询毫秒文案来自常量**：11 处错误文案里的 `~2400 ms` 改为插件侧 `~${SPACE_WATCH_TIMEOUT_MS} ms` 模板插值——生成后的脚本里仍是字面 `~2400 ms`（对外文案不变），改常量时文案自动跟随，且没有运行时字符串拼接。
- **N7 Page 的 `label` 不再要求 string**：`pagePrelude` 守卫从 `typeof page.label !== "string"` 放宽为 `page.label === undefined || page.label === null`——非字符串 label 的 Page 可用，`label` 缺失/`null` 仍可读失败。非字符串 label 会**原样进入结果字段**（如 `page: page.label`），消费方不要假设它一定是 string。
- **N9 结构化成功的 `log` 上限**：新增 `STRUCTURED_LOG_LIMIT = 16000` 与 `structuredLog()`：成功结果的 `log` 超限时截断并附 `logTruncated:true` + `logLength:<原长>`；未超限形状不变。**两个字段含义不同**：`logTruncated` 表示结构化 `log` 被 16000 字符截断，`truncated` 表示原始 CLI 输出被 `maxOutputBytes` 截断；`logLength` 是 **UTF-16 `.length`（字符数）**，不是字节数。`ego_app_run` 保持完整 log 契约。
- **N2① `ego_app_space` 的 `id` 优先于 name（行为变化）**：`spaceArg` 改为 id 优先，与 Page 工具/`ego_app_tabs{scope:'space'}` 一致——**同时传 `name` 和 `id` 时命中 `id`**（与 schema 一直的声明一致）；`id` 参数描述改为 "It wins over name for every action…"。**`id:0` 会命中用户默认空间**（0 是真实空间、不是占位值）——现有调用若为「备注」传了 `id:0`，升级后会真的改打用户空间；只传 `name` 才按 name 走。
- **文档**：README 中英新增 0.1.13 行为节（含 N2① 行为变化提示）；0.1.12 的 R1/R2/R3/R7/R11/R12 表述补「0.1.13 起…」前向说明；新增 `docs/TEST-RUN-2026-11-01-0.1.13.md`。
- 测试（最终 gate，2026-11-01 21:01:19–21:03:16）：`npm test` **112/112**、`live-e2e` **89/89**、`pointer-selector` **11/11**（0.1.12 为 103/89/11）。

## 0.1.12 — 2026-11-01

按 0.1.11 round-4 复核报告修 4 个 S2（R1–R4）与 R5–R11、冻结后审计修复 N1/N2/N5，并逐条修正 R12 文档漂移。

- **R1 Page 工具共用前导加固**：全部 Page 工具（16 个 `pageTool`，其中 15 个走 `pagePrelude`；`ego_app_gesture` 不走）共用的 `pagePrelude` 先校验 `task.pages()` 是数组（否则 `the TaskSpace page list is unreadable`），再校验 `newPage()`/`page()` 返回带 `label` 的 Page（否则 `did not return a Page: … (no command ran against a Page)`；0.1.13 N7 起只要求 label 存在，不要求 string）——坏 bridge 上不再继续跑命令。
- **R2/N2 同名空间歧义拒绝**：按 name 解析命中多个空间 → `the name '…' matches N spaces (ids …); pass the space id instead so this action cannot hit the wrong one`；`close`/`finish` 等不再可能打到「另一个同名空间」；`open` 前也做同名检查（读列表失败不阻塞 open）。**Page 工具与 `ego_app_tabs{scope:'space'}` 现在也接受 `id`（number，优先于 name）**，歧义时可直接用 id 定位（0.1.13 N2① 起 `ego_app_space` 也统一为 id 优先）。
- **R3 调用表达式与嵌套括号默认参数（语义澄清，非行为变化）**：`isFunctionSource` 本来就只把参数列表无嵌套括号的形式当函数源码——`(async () => 1)()`、`(0, () => 7)()` 与带嵌套括号默认参数的箭头都归 expression（`wait` 正确包裹、`ego_app_js` 走 expression），`() => 1`、`(a, b) => a`、`function(){…}`、`async () => 1` 仍是函数源码。本轮把语义写进文档并用测试锁死。（0.1.13 N4 进一步改为括号匹配：参数带嵌套括号的箭头现在被识别为函数源码。）
- **R4 dialog 双错误保留**：`acceptDialog`/`dismissDialog` 抛错不再抹掉点击错误——两条都报（`trigger click failed: …` / `answering the dialog failed: …`）；只有「点击失败且应答成功」保留旧措辞 `still answered (handled=…)`；应答本身失败会提示 dialog 可能仍开着（`retry ego_app_dialog without trigger, or reload the Page`）。
- **R5 app-open 诊断性预读失败不再阻塞创建**：`ego_app_tabs{scope:'app',action:'open'}` 的 `listTabs()` 预读失败 → 继续 `createTab()`，结果 `verified:null`（预读成功才给 `true`/`false`）。
- **R6 `1+1;` 真正修好**：`ego_app_js` auto 的 statementMode 判定改用 `normalizeSource(expr)`，`{expression:"1+1;"}` → expression → `value: 2`（`const x=1; return x;` 仍走 statements）；`test/generated-scripts.test.mjs` 的断言从 `ok===true` 改为 `value===2`。
- **R7/N1 结构化成功也能看到脚本/CLI 自身输出**：结构化工具成功且 CLI 有输出时，结果带 `log`；**ego 不把页面 console 转发到 CLI**，所以 `log` 是脚本或 CLI 自身的输出（页面内 `console.log` 不在其中）；无输出时不出现该字段（结果形状不变）。若此次输出被 `maxOutputBytes` 截断，同一结果还会带 `truncated:true`（未截断不出现）。（0.1.13 N9 起结构化 `log` 上限 16000，超限附 `logTruncated`/`logLength`；`ego_app_run` 不受此限。）
- **R8 `delete{}` 宿主侧拒绝**：没有 name/id/ids → `ok:false`（`… it never guesses which TaskSpace you mean.`）+ hint，**零 spawn**。
- **R9/N5 delete 的 skipped 与 still-listed 分开报**：`skippedRunningSpaceIds` 单独文案并**带 hint**（`ego only deletes spaces whose agent task has ended; close or finish them first, then retry the delete`）；只有真的还在列表里才说 `were still listed after ~2400 ms`；两者同时出现时**两条都报**。
- **R10 `Task space not selected` 专用 hint**：空间可能已消失——先 `ego_app_space{action:'list'}` 确认，否则先 open/use 再试。
- **R11 轮询常数命名**：`SPACE_WATCH_INTERVAL_MS = 150` / `SPACE_WATCH_TIMEOUT_MS = 2400`，delete 的 leftover 轮询复用同一常量；文档统一改为「每 150 ms 轮询、2400 ms 截止（实测 17 次 / ~2.6 s）」。（0.1.13 N6 起 11 处错误文案也由该常量插值派生。）
- **R12 文档漂移修正**：① `12×150 ms` 的旧写法（README/CHANGELOG 四处）改为「每 150 ms 轮询、2400 ms 截止（实测 17 次 / ~2.6 s）」（0.1.13 N6 起错误文案也由常量插值派生）；② `1+1;` 的声明由 R6 落实，测试断言为 `value===2`；③ render 的 20000 字符上限是**插件自己的常量**（`OUT.render` 的 limit），不是宿主预算；④ 任务结束丢输出的自然命中依赖应用状态，但兜底判定表已由扩展假 CLI 覆盖，不再算「未测的环境限制」；⑤ 0.1.9 close 竞态频率改为「曾观测 10/13–18/33，复测约 7%（1/14），频率随机器状态浮动；轮询对高频与低频都成立」；⑥ `delete{}` 现在由宿主侧拒绝（0 spawn）；⑦ app-open 预读失败 → `verified:null`；⑧ 结构化成功可带 `log`（脚本/CLI 自身输出，不是页面 console）；⑨ 同名空间歧义拒绝与 Page 工具前导守卫见 R1/R2。
- 测试（最终 gate，2026-11-01 20:21:20–20:23:17）：`npm test` **103/103**、`live-e2e` **89/89**、`pointer-selector` **11/11**（0.1.11 为 91/89/11）。
- 文档：README 中英新增 0.1.12 行为节；新增 `docs/TEST-RUN-2026-11-01-0.1.12.md`。

## 0.1.11 — 2026-11-01

第三轮收尾（0.1.10 → 0.1.11）：清零剩余 S3，把 0.1.10 的 fail-closed 主题补齐到 `ego_app_tabs`，并让生成脚本第一次可以脱离真应用、用假 CLI 单测。

- **A 日志不再吞页面输出**：`interpretCliOutcome` 的 `clean()` 只删除本次运行**真正的结果行**——带 token 的运行只删 `@@DSH_RESULT@@<token>` 开头的行；`ego_app_run`（token `""`）只删与本次选中结果行**完全相同**的那一行。页面自己打印的裸 `@@DSH_RESULT@@...` 现在会留在 `log` 里（以前被整行吞掉），解析顺序不变（哨兵 → onboarding → 退出码 → 纯文本 → 截断）。
- **B 读数失败细节安全化**：生成脚本新增 `describeRead(value)`（try/catch、`JSON.stringify` 结果截断 300 字符、异常回退 `String(value)`、再失败回退 `"(unprintable)"`）；`readTaskSpaces` 的错误文案改用它，`readSpacesHelper` 拆成 `describeReadHelper` + `readTaskSpaces` 供 tabs 复用——读数失败时错误里带得出细节，又不会把巨大/循环对象原样抛给宿主。
- **C 函数源码判定**：新增导出 `isFunctionSource(value)`（`new Function` 只解析、不执行函数体）。`ego_app_wait{for:'function'}` 用完整函数源码时内联 `(${expr})`，否则仍是旧的 `() => (${expr})`；`ego_app_js` 的 `fn` 参数走 function 模式，`mode:"auto"` 且表达式本身是函数源码时也走 function 模式，显式 `mode:"expression"|"statements"` 绝不自动切换。这同时修掉一个静默错误：`ego_app_js{expression:"() => 1+1"}` 以前被包成 `() => (() => 1+1)`、返回函数，JSON 里 `value` 静默消失；现在按函数源码处理并返回 `2`。
- **D 终态/移交动作先取值**：`ego_app_page{action:'close'}` 关闭前先取 `page.label`（生成脚本里存为 `__closedLabel`）；`close`/`finish`/`complete`/`mark_error`/`handoff`/`takeover`/`wait_control` 脚本开头取 `const __spaceId = task.spaceId`，之后只用它——动作把 label/spaceId 变成 `undefined` 也不再丢结果字段。用户数据（selector、文件路径等）里出现 `task.spaceId` 字面量不会被改写（只改手写生成片段）。
- **E `ego_app_tabs` 读数 fail-closed**：`scope:"app"` 的 `ego.listTabs()` 没有 `tabs` 数组时 `ok:false`（错误含 `the app tab list is unreadable`）；`scope:"space"` 的 `task.tabs()` 不是数组时 `ok:false`（错误含 `the TaskSpace tab list is unreadable`）。`action:"open"` 时同样不再把读失败降级成 `tabs: []`（`createTab()` 的结果不作为成功证据）。
- **F `create` 失败可读**：`createTaskSpace()` 没有返回 space id 时抛 `createTaskSpace() did not return a space id: <describeRead(created)>; no space was selected`，不再 `useTaskSpace(undefined)` 后静默失败。
- **G `dialog{waitMs}` 卫生**：非有限值或负数按 `0` 处理（默认仍是 400），不再把非法时长传给 `waitForTimeout`。
- **H `ego_app_status` 形状固定**：返回 `{version, versionError, profiles, profilesError, tabs, tabsError, tabsSpaceId, spaces}`——`version`/`profiles` 失败改为 `versionError`/`profilesError`（不再把带 `.error` 的对象当数据）；`tabs` 读不到时先用「最新 agent 空间」选一次再读（会短暂选择该空间，无其他副作用），成功则 `tabsSpaceId` 记录之，仍失败才给 `tabsError`。
- **I `ego_app_tabs` 结果补全**：`scope:'space'` 带 `targetId`/`openedBy`，`action:'open'` 带 `opened`；`scope:'app',action:'open'` 带 `created`（`createTab()` 返回值的 `describeRead` 字符串），且 app 的 open 也会在当前空间新增 managed Page、消耗 ego 每空间 8 页预算。
- **J `open_page` 必须拿到 Page**：`newPage()` 没有返回带 label 的 Page → 失败（不再 `ok:true` 且 `page` 被 lossless 丢掉）。
- **K `pages`/`tabs`/`adopt` 读数守卫**：`task.pages()`/`task.tabs()` 非数组 → 可读失败（`the TaskSpace page/tab list is unreadable`），不再裸 `TypeError: …map is not a function`。
- **L `adopt` 给证据**：`adopt()` 没返回 Page → 失败；成功后回读 `task.pages()` 返回 `verified:boolean`（是否真的被 agent 管理），不再只看调用返回值。
- **M `user_page` 兼容同步/异步**：改 `await task.userPage()`，两种返回形态都能工作。
- **N `dialog` 补全**：`promptText:""` 现在会真的传空串（只有缺省才表示不传）；结果带 trigger 的 `receipt`，`handled:false` 带 `note`；`waitMs` 负数/NaN → 0、上限 30000，且 `waitForTimeout` 被 try/catch 包住——点击已发生也一定继续应答 dialog。
- **O `fetch` 的 `saveAs` 回显**：`options.saveAs` 回显为 `saveAs`；工具/参数描述现在是「ego writes the file; the path is echoed back but not verified」，本调用不验证文件。
- **P `gesture` 空返回**：`shown` 在 API 返回空时是 `null`（以前 `undefined` 也报 true），`detail` 截断 500。
- **Q `describeReceipt` 截断**：dialog 的 `message`/`defaultPrompt` 等页面可控文本截断 2000 并标注 `…[truncated N chars]`。
- **R `ego_app_run` 的 `truncated`**：结果行完整但输出尾部被截断 → 结果带 `truncated:true`；exit≠0 的诊断顺序不变。
- **S 新 hint**：tab 读失败专用 hint（`would not list its tabs…`），adopt/release 与 Page budget（8 页）各一条。
- **T 前置解析**：`wait{for:'function'}` 与 `ego_app_js` 在 spawn 前用 `new Function` 只解析目标源码，语法错误 → 可读失败（`needs a valid function source or expression` / `… is not valid JavaScript`），不 spawn、零副作用。
- **U `ego_app_tabs` 空间解析**：统一用 `spaceArg`（空白 name 视同未给）。
- **N-a 尾部分号归一**：`ego_app_js`/`ego_app_wait{for:'function'}` 判定与包装前先去掉尾部分号——`() => 1;` 可用；statements body 保留原样。（`1+1;` 的 auto 判定到 0.1.12 的 R6 才真正走 expression 并返回 `value:2`，见 0.1.12 条目；当时生成脚本测试只断言 `ok===true`，已同步收紧。）
- **N-c app `open` 证据**：`ego_app_tabs{scope:'app',action:'open'}` 结果新增 `verified:boolean`（tab 列表是否真的变长）；只是证据，不因 `false` 报失败（避免列表刷新竞态）。
- **N-d/N-e adopt/release 守卫**：`adopt`/`release` 回读 `task.pages()` 非数组 → 可读失败（`the TaskSpace page list is unreadable`）。
- **N-f dialog 点击失败仍应答**：trigger 点击抛错时先应答 dialog，再抛点击错误（错误带 `any dialog it raised was still answered (handled=…)`），不会留下未应答 dialog。
- **N-g `tabsSpaceId` 出现时机**：只有「选中空间后重读成功」才出现，不再与 `tabsError` 同时出现。
- **保守的 locator 策略**：未闭合引号（如 `[data-x="a>>b]`）仍按纯 CSS 处理，不猜成 ego locator；已被测试锁死——宁可查不到，也不把合法 CSS 误判成 locator。
- **测试**：新增 `test/function-source.test.mjs`（`isFunctionSource` 真/假表）与 `test/generated-scripts.test.mjs` + `test/fake-cli/nodejs`（假 ego CLI 断言生成脚本的 B/C/D/E/F/G 与 0.1.10 既有形状），`cli-outcome`/`locator-detect` 增量。**真浏览器 live 套件必须串行跑**：ego 的「当前选中 space/page」是应用级全局状态，并发会串页。
- **文档**：README 中英新增 0.1.11 行为节（A–G、未闭合引号保守、串行约束）；新增 `docs/TEST-RUN-2026-11-01-0.1.11.md`。测试计数（最终 gate，2026-11-01 19:07:14–19:09:02）：`npm test` **91/91**、`live-e2e` **89/89**、`pointer-selector` **11/11**（0.1.10 为 48/89/11）。

## 0.1.10 — 2026-11-01

0.1.9 的收尾轮：修 0.1.9 验证/审计报告里的 **3 个 S2 残留**（读数失败被当成空间消失、任务结束兜底把已达成状态判失败、`keepPages` 未验证——最后一项已在上一轮补掉）、delta 审计的 **4 个 NEW 项**，以及 verifier §13.2 的 `list` fail-open 等问题。

- **读数失败 = 失败（fail-closed）**：`ego_app_space{action:'list'}`、`ego_app_status`、`delete`、空间动作的前置解析、以及六个「轮询后回读」动作（`close`/`finish`/`complete`/`mark_error`/`handoff`/`wait_control`），在 `ego.listTaskSpaces()` 返回错误对象或缺 `taskSpaces` 数组时**一律报失败**（错误含 `unreadable`，hint 指向先 `list`/`ego_app_status` 再重试），不再把「读失败」当成「没有空间 / 删除成功 / 空列表」。`ego_app_status` 的 tabs 读失败降级为 `tabs: []` + `tabsError`，空间列表本身成功时整体仍 `ok:true`。**两类读失败刻意区分**：`create`/`use`/`claim` 动作后的列表刷新是 **best-effort**——读失败只给 `spacesError` 字段，仍返回 `ok:true`（动作本身的 `spaceId` 等证据已经拿到）；`list`/`ego_app_status`/`delete`/空间前置解析/六个回读则**必须** fail-closed，读不到就报错。
- **`list` 不再 fail-open**（verifier §13.2）：旧实现读失败时返回 `{count:0, spaces:[]}`，所有「用 list 证明空间已消失」的验证都被静默放宽；现在直接失败并带可读原因。
- **任务结束兜底的字段补齐**：兜底成功结果补齐正常路径会返回的字段——`takeover` 按 name 调用时带 `name`（按 id 调用拿不到就不补）、`wait_control` 带 `requestedTimeoutMs`/`timeoutMs`/`clamped`/`value`、`finish` 带 `keep`（宿主请求值）。`finish(keep:true)` 的兜底 note 明确「页面级保留无法用空间列表验证，需要 `keptManagedLabels` 请用正常路径回执」。
- **`timeoutMs` 卫生**：显式 `<= 0` / 非有限值在副作用之前直接拒绝：`timeoutMs must be a positive number of milliseconds (it is a duration, not a flag).`；`ego_app_page{action:'reload'|'focus'}` 现在透传 `timeoutMs`（`close` 没有参数），第 16 条的「page 不透传」说法随之作废。
- **locator 引号不误判**：`[data-x="a>>b"]`、`[title=":has-text("]` 这类**引号内**含 locator 标记的合法 CSS 不再被误判成 ego locator；引号外的 `>>`/`:has-text(` 仍按 locator 交给 ego 自己的解析器（`plainCssFrom` 增加引号剥离）。
- **`ego_app_js` 新增 `mode`**：`auto`（默认，保留原标点启发式）/ `expression` / `statements` / `function`；`fn` 等价 `function`。`ego_app_wait{for:'function'}` 接受**完整函数源码**，不再被包成 `() => (...)` 导致等待恒真。
- **`pageCreated` 可见**：**真正的 Page 工具**（`navigate`/`snapshot`/`screenshot`/`click`/`fill`/`key`/`pointer`/`select`/`wait`/`js`/`cdp`/`dialog`/`upload`/`download`/`page`）结果带 `pageCreated`，静默 `newPage()` 不再是隐形的；`ego_app_space{action:'open'}` 修回与 0.1.9 一致（**不返回** `pageCreated`，也不再自动建 Page——新空间 `pages` 可能为空，首次 Page 工具调用才 `newPage()`），`ego_app_gesture` 同样不返回。
- **abort 真取消**：调用方取消（AbortSignal）会 kill 子进程并立即返回 `aborted by the caller`，不再等到插件级 180 s 上限。
- **哨兵 nonce**：插件生成的脚本把结构化结果哨兵换成 per-run 随机后缀（`@@DSH_RESULT@@<nonce>`），页面文本伪造整行哨兵不再能顶替结构化结果。nonce 只替换插件自己生成的那一行打印表达式，**用户脚本里出现同名字面量（含 `@@DSH_NONCE_SLOT@@`）不会被改写**；`ego_app_run` 保持 plain `@@DSH_RESULT@@` 契约。带 token 的结构化调用若拿不到本 run 的哨兵行，会报专门的「没有携带本次运行 token 的结果行」，不再误称「脚本没跑」。
- **render 截断有标记**：结果超过 20000 字符时追加 `…[renderedTruncated omittedChars=N limitChars=20000]`，不再静默截断。 **20000 是插件自己的常量**（`OUT.render` 的 limit），不是宿主预算——这是我们的选择。
- **新 hint**：`no space with id`、`only removes user-owned`、`matches N spaces`、`could not be read|could not be verified` 等失败现在都带下一步建议；hint 仍优先给具体观测（具体状态覆盖泛化的安装/onboarding 提示）。
- **其它**：`lossless()` 改为递归过滤（嵌套对象/数组里的 `undefined` 不再漏给宿主）；Page 工具的结果统一过 `lossless`。
- **文档/测试**：README 中英新增 0.1.10 行为变化节并更新第 16 条；新增 `docs/TEST-RUN-2026-11-01-0.1.10.md`。测试：`npm test` **48/48**（`cli-outcome` 21、`output-collector` 6、`locator-detect` 5、`ended-task-outcome` 16）；`live-e2e` **89/89**、`pointer-selector` **11/11**（`EGO_E2E_REQUIRE=1`，2026-11-01 实跑；0.1.9 为 43/72/11）。

## 0.1.9 — 2026-11-01

按 0.1.8 验证报告修「`ok:true` 已经可信、`ok:false` 还不可信」的一批问题：本轮重点是让**失败结论也有实测依据**，并收掉 0.1.8 修复自身引入的回归。

- **`close` 改为轮询回读（修 0.1.8 的新回归）**：0.1.8 在 `closeTaskSpace()` 之后只读一次空间列表，而 ego 要 24–26 ms 才把条目移出列表，于是**已经关掉的空间被报成失败**（曾观测到 10/13–18/33 次误报，复测约 7%（1/14），频率随机器状态浮动；错误文案还把 agent 引向一次毫无必要的 `handoff`/`claim`）。现在照 `delete` 的做法轮询（每 150 ms 轮询、2400 ms 截止；实测 17 次 / ~2.6 s）直到 id 消失：只有 ego **明确拒绝**（`closeTaskSpace()` 回执带 `error`，例如空间已委派给用户）、轮询后**仍在列表**、或空间列表**读不出来**（见下 `unreadable`）才 `ok:false`，错误文案改为「等 ~2400 ms 后仍列出（observed ownership=…）」+ 下一步 `hint`，不再断言「这是委派给用户的空间」。
- **严格空间解析：除 `open` 外绝不创建空间**：官方 `taskSpace(name)` 的语义是 **reuse *or* create**，所以「close 失败 → 重试 close」会静默新建一个同名空间、再把它关掉并返回 `ok:true`：看起来修好了，实际什么都没修还多出一个空间。现在除 `open` 外的空间动作（`close`/`finish`/`complete`/`mark_error`/`handoff`/`wait_control`/`delete`/`pages`/`tabs`/…）一律先 `listTaskSpaces()` 解析**已存在**的空间、再按 id 恢复；**空间动作（含 `open`；`list`/`create` 除外）必须显式给 `name` 或 `id`**——空白 name（如 `"   "`）等同缺省——省略时宿主侧直接报 `name (string) or id (number) is required for this action`（附 hint、零副作用，避免误关最新空间）；只有 page 工具（`navigate`/`snapshot`/`click`/`fill`/…）可省略 name，取最新的 agent 空间（没有则取最新的 `agentDelegatedToUser` 空间）；找不到时统一报 `… is currently open. This action only operates on an existing space; it never creates one.`（0.1.8 那句「Never creates a space」的注释从本轮起才与事实一致）。
- **六个动作统一回读语义（行为变化）**：`finish`/`complete`/`mark_error`/`close`/`handoff`/`wait_control` 共用同一套「轮询后回读」；`ownership` 是实测值；「空间已消失」统一记作 `"closed"`——对 `close`/`finish`/`complete`/`mark_error` 算成功（终结类动作不再靠 `if (… && …)` 在空间已被别处关闭时「真空通过」），对 `handoff`/`wait_control`/`takeover` 算失败（没有空间就不可能达成目标状态）。
- **读数失败不等于空间消失**：`listTaskSpaces()` 返回错误对象或缺少 `taskSpaces` 时，`close`/`finish`/`complete`/`mark_error` 不再把读失败当「空间已关闭」报 `ok:true`，而是**报失败**，`error` 里带 `observed ownership: unreadable`（hint 指向先 `list`/`ego_app_status` 再重试）；任务结束兜底的探针若读失败会**放弃兜底、保留原始错误**。`unreadable` 表示状态没能确认——既不是成功，也不是「已完成转换」。
- **任务结束导致输出被丢弃（修 `close` 的残留误报）**：ego 在动作触发的任务结束时可能 hard-stop 脚本并**丢弃已缓冲输出（含哨兵）**，只打印 `This task space is no longer assigned to the agent: its task has ended … browser commands are paused` 并退出 0。旧版会把这种**其实已经成功**的 `close` 报成「脚本没跑」。现在 `ego_app_space` 的 `close`/`finish`/`complete`/`mark_error`/`handoff`/`wait_control`/`takeover` 命中该通知时会先做一次独立只读 `listTaskSpaces()` 复核：终结类动作可能返回 `{ok:true, …, receipt:null, verifiedBy:"listTaskSpaces", note:"…"}`（**`receipt:null` 不是失败**，表示回执被 ego 丢了、结论来自独立复核；`finish` 的 `keep` 在该路径上也是 `null`；空间不在列表 → `ownership:"closed"`，仍在列表但 ownership 为 `user` → 对 `finish(keep:true)`/`complete`/`mark_error` 也算成功）；`handoff`/`takeover`/`wait_control` 若复核到**目标态已经达成**（`agentDelegatedToUser`/`agent`/`agent`）同样返回 `ok:true`（`handedOff`/`tookOver`/`control` + `verifiedBy`），不再因为「脚本没跑完」把已达成的状态判失败，空间已消失时这三个仍失败。**按 name 寻址且空间已消失时，兜底结果的 `spaceId` 可能为 `null`**（插件拿不到 id，只有按 id 传入才回显）——`spaceId:null` + `verifiedBy:"listTaskSpaces"` 是成功，不是缺字段。`finish{keepPages:[...]}` 命中该通知时**不恢复**（page 级结果无法用空间列表验证，保留原始失败）；`finish(keep:false)` 在该路径上若空间仍以 `user` 列出则失败（要关掉却没关掉，hint 指向按 id `delete` 或面板关闭）。兜底只在「命中该通知且原判失败」时触发，正常路径仍返回 ego 原生回执；同一通知出现在 `ego_app_run` 的纯文本输出里时仍按成功返回，不会被误判为失败。
- **`finish` 透出 ego 回执**：结果里的 `receipt` 带 `closedSpace`/`keptManagedLabels`/`closedManagedLabels`/`preservedUnmanagedCount`，不必再靠回读推断 keep 的真实效果；`complete`/`mark_error` 的 `receipt` 是 ego 返回的字符串（此前这些回执被丢弃）。另外 `finish(keep:false)` 的期望状态**由请求决定**：即使 ego 回执缺 `closedSpace` 字段，也要求空间消失，否则失败（不再依赖回执形状）。
- **`wait_control` 的 `timeoutMs` 真正可用**：0.1.8 只读了参数、没写进 schema（schema 驱动的调用方看不见）；现在已进 schema，并把有效值 clamp 到插件级预算内（`config.timeoutMs - 5000`；默认配置下有效上限 175 s、不传该参数时默认 165 s），结果带 `requestedTimeoutMs`/`timeoutMs`/`clamped`。
- **更正 0.1.8 的两处 `timeoutMs` 措辞**：0.1.8 说的「补上 `timeoutMs` 参数」只兑现了一半（代码读了，schema 没有）；「此前登录超过 3 分钟必撞 180 s」读起来像已经解决，但**180 s 的插件级预算一字未动**——本轮做的是把请求值 clamp 进预算并在结果里说明，想等得更久仍只能调大配置 `timeoutMs`，不是工具参数能绕过的。
- **`ego_app_run` 截断回归修好**：0.1.8 把截断检查排到了 `allowPlainText` 前面，纯文本输出一大就 `ok:false`（`full_page` 快照或批量 `innerText` 很容易到 1 MiB）；现在纯文本超限仍是 `ok:true` + `truncated:true`，onboarding 预检与退出码判定也不会再被截断分支遮住。同时 `maxOutputBytes` 改为按 **UTF-8 字节**计（此前按 UTF-16 码元，中文要约 3 倍才判定超限）。
- **N11 locator 判定补全**：`css=`（等价于原样 CSS）、后缀形式 `:has-text("…")`/`:text-is("…")`/`:text("…")`、`>> nth=N` 这些 ego locator 不再被塞进 `document.querySelector`（预滚动/滚动捕获会先剥掉 `css=`，其余形式交给 ego 自己的 locator 解析）；`mouse_click` 接受 `css=`，其余 locator 形式给出可读拒绝；`mouse_click` 用 CSS 选择器时先滚进视口点击，**点击后恢复原视口位置**（与 trigger 点击一致）。
- **A4 超时预算是整次调用**：`download`/`file_chooser`/`wait_event` 的 `timeoutMs` 现在是整次调用的总预算——trigger 点击用「剩余预算」（下限 500 ms），不再被点击与等待器各自 `Math.max(3000,t)` 花一次。
- **`delete` 不再「报成功但没删成」**：轮询后 `stillListed` 非空、或 ego 回执里 `skippedRunningSpaceIds` 非空，现在都**报错**（带 hint），不再 `ok:true` 了事；结果里带 `deletedIds`/`stillListed`/`skippedRunningSpaceIds`/`receipt`（ego 回执 `{deletedSpaceIds, skippedRunningSpaceIds}`）；支持 `id`（单数）与 `scope:"task"`，`scope:"all"` 明确拒绝。更严格：`force:true` **不能**绕过 agent-owned 目标（一律 `ok:false`，错误含 `force:true cannot make ego delete…`，目标 id 点名列出），`ids` 里有不存在的 id 会点名，按 `name` 命中多个空间会报错要求改传 `ids`。
- **枚举守卫补齐（A3 同类）**：`select{}`（没给 value/label/index，此前会清空选择）、`fill{}`（缺 value，此前写入空串）、`tabs{action:"open"}` 缺 url（此前开 `about:blank`）、`wait{for:"url"}` 缺 url 现在都返回可读错误，不再静默执行。
- **新的失败都带 `hint`**：`close`/`finish`/`complete`/`mark_error`/`handoff`/`wait_control` 的回读失败原本只有 error 文本，现在统一从观测到的状态推导下一步（先 `list` 看现状、用户在控制时先 `wait_control`、空间已消失就说明无需重试等）。 hint 有优先级：具体观测（`task has ended`/`unreadable`/实测 `ownership`）会覆盖泛化的「检查安装/完成 onboarding」提示。
- **文档**：修 0.1.8 验证报告 §6 的 M1–M7、M11——`npm test`/`live-e2e` 计数（M1/M2）、过时的「99 项矩阵…全部通过」（M3：那是 0.1.0 时代的数字，历史报告已标「历史记录」）、英文 README 把 0.1.1 日志称作 "the current run log"（M4）、`timeoutMs` 措辞（M5/M6）、README 第 16 条像穷举的 `timeoutMs` 清单（M7）、以及「动作转换成功之后仍可能返回 `ok:false`」这一行为变化（M11）。
- 测试：`npm test` **43/43**（`cli-outcome` 17、`output-collector` 6、`locator-detect` 4、`ended-task-outcome` 16）；`live-e2e` **72/72**、`pointer-selector` **11/11**（`EGO_E2E_REQUIRE=1`，2026-11-01 实跑；0.1.8 为 12 单测 / 36 live）。0.1.9 的实测记录见 `docs/TEST-RUN-2026-11-01-0.1.9.md`。

## 0.1.8 — 2026-11-01

按 0.1.7 调查报告修"能干活但会说谎"的 5 类问题（核心：`ok:true` 要可信）。

- **A1 `wait_control` 不再写死成功**：`control: true` 是字面量，`waitForControl()` 返回假值也照样报成功。
  现在等待结束后回读 `ownership`，不是 `agent` 就报错；成功时返回实测的 `ownership`。顺带补上 `timeoutMs` 参数
  （此前用户扫码登录超过 3 分钟必然撞插件级 180 s 超时，且失败时回执/提示全丢）。
- **A2 终结/破坏性动作改为"回读后再说成功"**：`close` 检查空间是否真的从列表消失；`finish`/`complete`/
  `mark_error` 检查归属是否已变 `user`；`handoff` 检查是否变 `agentDelegatedToUser`；`release` 检查 Page 是否
  真的不再受管。不满足就报错（README 第 7 条自己也写着 `closeTaskSpace` 会"返回成功但不生效"）。
- **A3 枚举白名单**：`key` 的 `action` 拼错不再落到 `keyboard.press("Enter")`；`dialog` 的 `action` 不再
  "只有 `=== 'dismiss'` 才 dismiss"（现按小写归一后校验，`Dismiss` 会被明确当作 dismiss 并在返回值里写实）；
  `cdp` 的 `scope`、`wait` 的 `for`、`gesture` 的 `action` 同样白名单校验；`navigate` 必须给 `url`
  （不再静默开 `about:blank`）；`upload` 必须有非空 `files`（不再静默清空 file input）。
- **A5 结果完整性**：哨兵改为**取最后一行**匹配（脚本最后打印，页面文本伪造的早行不再可能顶替）；
  输出被 `maxOutputBytes` 截断时明确报"输出超限"，而不是误报"payload was not valid JSON"。
- **N11**：`:has-text()` / `>>` 这类 Playwright 风格选择器不再被当成纯 CSS 塞进 `querySelector`，
  提前报可读错误。
- **N15**：`finish(keep:false)` 之后紧跟 `delete` 的报错文案说明"空间已随之消失，没有可删的"，
  不再看起来像失败。
- **文档**：英文 README 的"对话框跨调用自动关闭"是**反的**，已改成实测结论并补齐对应语义条目（英文 README 用 bullet 而非编号）；
  中文第 16 条 `timeoutMs:8000` 的解法实测**仍然失败**（8.2 s），改为"预算 ≥ 15 s 或先滚动"
  （实测 15 s 通过 11.7 s、先滚动 0.36 s）；注明 `pointer` 没有 `timeoutMs`；`docs/TEST-REPORT.md`
  标注为 0.1.0 时代历史记录。
- 测试：`npm test` 12 项（+3：哨兵取最后一行、截断报错两种）；`live-e2e` **36 项**
  （+2：枚举拼错必须报错、`wait_control` 回读归属）。

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
