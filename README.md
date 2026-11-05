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

## 行为变化（0.1.16，升级前必读）

0.1.16 按 [docs/BUG-STANDARD.md](docs/BUG-STANDARD.md) 的判定标准把 0.1.15 遗留的缺陷清完。该标准把**判定**（是不是缺陷：以 L1–L5 的独立 oracle 为准）与**处置**（修不修）分开，并且"已知限制"只改变处置、不改变判定。

1. **行注释按 ECMAScript 行终止符结束**（L1 ECMAScript + L4 与 V8 差分）：`saysNothing()` 以前只认 `\n`，`{expression:"// c\u000d1"}`（孤立 CR 行尾）或 U+2028/U+2029 行尾会被误判成"空源码"并拒绝。现在 LF/CR/U+2028/U+2029 都算行尾；`"// c\u000d\u000a1"`、`"// c\u000a1"` 行为不变，纯注释仍然拒绝。
2. **函数值标记带每次调用的随机 nonce**（L3-1/L3-8）：以前宿主只比对 `rawValue.__dshFunctionValue === true`，页面数据或调用方表达式返回 `{__dshFunctionValue:true, secret:42}` 会被误报成"函数值不可承载"并**丢掉整个对象**。现在标记里带随机 token，伪造值按普通 JSON 返回（`value` 完整、无 `valueType`），真函数仍返回 `{value:null, valueType:"function", note}`。
3. **`fn:` 与另一个来源/模式冲突时被拒绝**（L3-5）：`{fn:"(x)=>x", arg:2, mode:"expression"}` 以前静默忽略 `mode`；`{fn:"(arg)=>arg.n", expression:"999"}` 以前静默丢掉 `expression`。现在两者都报错（`fn:` 等价 `mode:"function"`；`fn:` 与 `expression:` 只能二选一）。
4. **`arg` 只在"源码会被调用"时接受**（L3-5）：`mode:"statements"` / `mode:"expression"` 下传 `arg` 以前被静默丢弃；auto 回落到语句体时同样丢弃。现在这三种情况都直接拒绝并说明替代（`fn:` / `mode:"function"` / 单个表达式）；auto + 函数源码仍允许（`arg` 的生效条件写进了 schema 描述）。
5. **`wait` 的空源文案统一**（L3-6）：`{for:"function", expression:"; ;"}` / `"// c"` / `"/*c*/;"` 现在与 `";"` 一样返回 `expression is required for for="function".`（以前走 `not a single expression`）。`String(args.expression ?? "true")` 的死默认值一并删除。
6. **"不生效的参数"一律拒绝，不再静默忽略**（L3-5，覆盖 `ego_app_key` / `ego_app_pointer` / `ego_app_page` / `ego_app_gesture`）：
   - `ego_app_key`：`press`/`down`/`up` 必须显式给 `key`（以前缺省会**静默按 Enter**，可能提交表单）；`selector` 只对 `press` 有效、`html` 只对 `paste` 有效、`text` 只对 `type`/`insert_text`/`paste` 有效，越界组合报错。
   - `ego_app_pointer`：`move` 必须给 `x`/`y`、`scroll` 必须给非零 `deltaX`/`deltaY`（以前分别静默移动到 (0,0)、滚 0）；`button`/`from`/`to`/`x`/`y`/`deltaX`/`deltaY`/`label` 只对相应 action 有效。
   - `ego_app_page`：`selector` 只对 `focus`、`url`/`options` 只对 `fetch`、`files` 只对 `file_chooser`、`event`/`saveAs` 只对 `wait_event`（`saveAs` 仅 download）、`trigger` 只对 `file_chooser`/`wait_event`；`fetch` 不再接受 `timeoutMs`（它从未被使用），`fetch` 缺 `url` 直接报错。
   - `ego_app_gesture`：`highlight` 必须给 `x`/`y`（以前画在 (0,0)），`command` 只对 `gesture` 有效；`gesture` 的默认命令现在回显在结果的 `command` 字段里（`highlight` 回显 `point`）。
   - `ego_app_wait`：按 `for` 校验参数（`wait{for:"url", selector:"#x"}` 以前忽略 `selector`）；`load_state` 现在真的把 `timeoutMs` 传给 `page.waitForLoadState`。
   - `ego_app_space` / `ego_app_tabs` / `ego_app_dialog`：每个 action 只接受自己的参数（如 `create{id}`、`list{ids}`、`tabs{scope:"space", url}`、`dialog{dismiss, promptText}` 都会报错而不是静默忽略）；`tabs` 的非法 `scope` 不再被当作 `app`；`dialog` 的 30 s `waitMs` 上限回显为 `waitMs:{requested,applied,clamped}`。
   - `ego_app_click`：`clickCount` 必须是正整数（`0` 以前被当作 falsy 静默变成单击）。
   - `ego_app_select`：`index` 与 `label`/`value` 同传报错（`index` 以前无条件最先命中，另两个标识符静默蒸发；`label` 覆盖 `value` 是既有文档行为，不变）；`wait_event` 的非法 `event` 现在先按事件名报错。
7. **`ego_app_space{action:"finish"}` 的 `keep`/`keepPages`**（L3-5）：`keepPages: []` 现在表示"一页都不留"（以前被当成"没传"，反而保留全部）；同时传 `keep` 与 `keepPages` 会报错，不再让 `keep` 被静默忽略。
8. 以上每条都在 spawn 之前拒绝（"Nothing ran" 仍成立），并各有回归测试（P14–P25）。

## 行为变化（0.1.15，升级前必读）

0.1.15 把"手写词法扫描器"整体删掉，换成**用引擎自己的 parser 当 oracle + 一个 value probe**；上一版那些"注释/正则/生成器/嵌套默认参数"的分类边缘从根上消失。

1. **`ego_app_js` / `wait{for:'function'}` 不再猜"这是函数源码还是表达式"**：`parsesAsExpression()` 只编译、不执行，而且同一源码必须**同时**通过 `(src)` 与 `[src]` 两种包装（双包装 oracle：一种括号的语句逃逸会让另一种失衡）；`valueProbe()` 求值后**仅当结果确实是函数才调用它**（`await` 之后判断）。所以 `wait{for:'function', expression:"(x = 1) => x > 5"}` 会真的等到超时，而不是把箭头本身当 truthy 立即通过。
2. **`js` 的 `auto` 语义**：源码是单个合法表达式 → 求值；结果若是函数 → **调用**（`() => 1+1` 得 2，`() => ({a:1})` 得对象）。**只想取值、不想调用**时用显式 `mode:"expression"`：它绝不调用源码，结果是函数时返回 `{ value: null, valueType: "function", note: … }`（以前会静默消失）。
3. **函数值不再静默丢（含 async/Promise）**：`mode:"expression"` / `mode:"function"`（函数返回值） / `mode:"statements"`（体内 `return` 出函数）与 auto 都在 **`await` 之后**判断，`async () => () => 1`、`() => Promise.resolve(() => 1)`、`Promise.resolve(() => 1)`、`(async () => () => 1)()` 同样标记 `valueType:"function"`。副作用：`mode:"statements"` 体现在**支持顶层 `await`**（以前是语法错误），所有模式的 Promise 都会被 await/flatten。
4. **尾分号是值的一部分**：`{expression:"1+1;"}` → 2、`{expression:"() => 1;"}` → 1、`fn:"(x)=>x+1;"` + `arg` 正常（只做 trim，不是词法分析）。
5. **空源码被拒绝（守卫是线性扫描）**：`ego_app_js{}`、`{expression:""}`、以及**只含空白/分号/注释**的源码（`;`、`;;`、`; ;`、`; // c`、`/*c*/;`）→ `expression is required`；`wait{expression:";"}` 同样报 `expression is required for for="function"`（以前会静默求值出 `undefined`）。
6. **包装逃逸在 spawn 前被拒绝**：同一源码必须同时通过 `(src)` 与 `[src]` 两种编译（双包装 oracle），所以 `js{expression:"1); evil(); (2"}` 这类"关闭括号后写语句"的源码得到可读错误且**零 spawn**——"Nothing ran" 的承诺成立。
7. **已知限制（宣布不修，不是待办 BUG）**：
   - (A) **0.1.16 修正了这里的描述**：双包装 oracle 挡住的是"语法级逃逸"——要逃出 `( … )` 必须闭合 `)`、要逃出 `[ … ]` 必须闭合 `]`，同一段源码里同时做到这两件事必然在其中一侧留下多余括号（实测 25 条混种全部拒绝、"Nothing ran" 成立）。而**通过门禁的源码本身就是合法表达式**，所以它当然可以执行代码（`(() => { evil() })()`）；那是 `ego_app_js` 的固有能力，不是 oracle 的缺口——引入 JS parser 也消不掉。调用方与 `ego_app_run` 是同一主体，威胁模型上没有增量。
   - (B) `js` 的 `auto` 会**调用**函数值：生成器函数被调用返回 truthy 迭代器（wait 会立即满足）、`class A {}` 被调用会抛 `Class constructor cannot be invoked without 'new'`。要"只取值不调用"用 `mode:"expression"`。`wait{for:'function'}` 的谓词同样**每次轮询都会求值并（若是函数）调用一次**，有副作用的函数不要当谓词；谓词抛错会中止等待并直接报错。
   - (C) 其余既有 S3（0.1.16 逐条确认并补登记，不修）：结构化 `log` 上限 16000（`logLength` 是 UTF-16 字符数）、非字符串 label 原样进结果、`id:0` 是真实空间、JSON 承载限制（regex/Map/Set/Date/迭代器 → `{}`）、`a: 1` 这类合法语句体在 auto 回落 statements 后无值、`syntaxProblem` 只是"生成后自检"而非输入门禁、上游/环境类限制（adopt 成功路径需用户页、真 app 同名空间不可构造、status 面板高亮不可观测、每空间 8 页预算、真浏览器套件必须串行）。

## 行为变化（0.1.14，升级前必读）

0.1.14 收掉 0.1.13 残留的最后两条 N4 词法边缘（N4-a/N4-b），其余行为不变。

1. **N4-a 跳过注释**：`isBareFunctionSource` 的扫描器现在会跳过 `//` 行注释与 `/* … */` 块注释——注释里的 `}`/`)`/引号不再打断函数源码识别。`(x) => { // note
 return x; }`、`(x) => { /* } */ return x; }`、`(x) => x /* ) */ > 0` 现在都判为函数源码；以前它们会被归成 expression、被包成 truthy 箭头，导致 `wait{for:'function'}` **首轮假通过**。**注释在扫描器里等同空白**：跳过 `//` 与 `/* */` 但不改变词法状态，所以 `return /*c*/ /}/.test(x)`、`(a = /*c*/ /[)]/…) => a`、`(a) => a + /*c*/ /[)]/` 也都是函数源码；**头部注释**（`function /*c*/ f(){}`、`async /*c*/ () => 1`、`function* /*c*/ g(){}`）同样支持；**`function` 与生成器的 `*` 之间也允许注释**（`function /*c*/ * g() {}`、`async /*c*/ function /*c*/ * g() {}` 都判为函数源码）。**注意生成器语义**：`function*` 被正确识别为函数源码，但把它用作 `wait{for:'function'}` 谓词时，调用返回的是 truthy 的迭代器对象 → 会立即通过；这是 JS 语义而不是分类假通过，需要布尔谓词请用非生成器函数（如 `function /*c*/ () { return false; }`）。
2. **N4-b 关键字后的 regex**：`return`/`typeof`/`instanceof`/`case`/`yield`/`await`/`delete`/`void`/`in`/`of`/`new`/`do`/`else`/`throw` 之后出现的 `/…/` 会被当作 regex 跳过（`(x) => { return /}/.test(x); }`、`(x) => typeof /}/.test(x)` 现在判为函数源码）。
3. **不变的部分**：调用表达式 `(async()=>1)()`、`(0,()=>7)()`、`function(){}()`、`((a)=>a)` 仍按 expression；字符串/模板里的 `//` 与括号不受影响（先 `skipQuoted`）；除法 `a / 2`、`a++ / 2`、`a && /x/.test(a)` 仍正确；解析层 `new Function("return (src);")` 仍是最终门槛。 仍保留的极窄边界（不影响本轮目标）：语句位 `)`/`}` 之后的 regex（`if (x) /}/…`）、文件尾 `//` 无换行（js 路径给可读错误）、`async => 1`。注：`(a /* ) */) => a` 现在为 **true**（注释等同空白），不属于残余。

## 行为变化（0.1.13，升级前必读）

0.1.13 收掉 0.1.12 审计记的 5 条 S3 follow-up（N4/N6/N7/N9/N2①）。

1. **`isFunctionSource` 改为括号匹配（N4）**：参数里带嵌套括号的箭头（`(x = foo()) => x > 0`、`(a = (1)) => a`）**现在被正确识别为函数源码**；以前 `wait{for:'function'}` 会把它们包成 `() => (…)`，箭头本身 truthy → **首次轮询即通过（假通过）**，现在已消失。0.1.13 起下面四类也**全部按表达式处理**（整段必须恰好是一个函数表达式）：`(async () => 1)()`、`(0, () => 7)()`、`function(){}()`、`((a) => a)`——其中 **`function(){}()` 在 0.1.12 旧版曾被判为函数源码**，另外三个旧版本来就是 expression（不要写成「与上一版一致为 false」）。`document.title` 等普通表达式同样按 expression。**正则字面量里的括号也不会被误判**：`(x) => /\)/.test(x)` 这类源码中，`/` 会被识别为 regex 并跳过 `[...]` 字符类与转义，括号配对不受影响。
2. **轮询文案由常量派生（N6）**：11 处 `~2400 ms` 错误文案改为在插件侧用 `~${SPACE_WATCH_TIMEOUT_MS} ms` 模板插值（生成后的脚本里仍是字面 `~2400 ms`，对外文案不变）；改常量时文案自动跟随，且没有运行时字符串拼接。
3. **Page 的 `label` 不要求 string（N7）**：`pagePrelude` 只要求 Page 有 `label`（非字符串也可用），`label` 缺失/`null` 仍可读失败——不再因为 label 不是字符串把正常 Page 判失败。注意非字符串 label 会**原样进入结果字段**（如 `page: page.label`），消费方不要假设它一定是 string。
4. **结构化成功的 `log` 有上限（N9）**：结构化工具成功时 `log` 上限 **16000 字符**，超限截断并附 `logTruncated:true` + `logLength:<原长>`；未超限形状不变。**两个字段含义不同**：`logTruncated` 表示结构化 `log` 被 16000 字符截断，`truncated` 表示原始 CLI 输出被 `maxOutputBytes` 截断；`logLength` 是 **UTF-16 `.length`（字符数）**，不是字节数。`ego_app_run` 仍返回完整 log（契约不变）。
5. **`ego_app_space` 的 `id` 现在优先于 name（N2①，行为变化）**：与 Page 工具、`ego_app_tabs{scope:'space'}` 一致——**同时传 `name` 和 `id` 时命中 `id`**（与 schema 一直的声明一致）。**`id:0` 会命中用户默认空间**（id 0 是真实空间，不是占位/备注值）——现有调用若为「备注」传了 `id:0`，升级后会真的改打用户空间；只传 `name` 才按 name 走。

## 行为变化（0.1.12，升级前必读）

0.1.12 收掉 round-4 复核的 4 个 S2（R1–R4）与其后的 R5–R11、冻结后审计修复的 N1/N2/N5，并逐条修正上一轮遗留的文档漂移（R12）。

1. **Page 工具共用前导加固（R1）**：全部 Page 工具（16 个 `pageTool`，其中 15 个走 `pagePrelude`；`ego_app_gesture` 不走）共用的 `pagePrelude` 现在先校验 `task.pages()` 是数组（否则报 `the TaskSpace page list is unreadable`），并校验 `newPage()`/`page()` 返回带 `label` 的 Page（否则报 `did not return a Page: … (no command ran against a Page)`；0.1.13 N7 起只要求 label 存在，不要求是 string）——不再在坏 bridge 上继续跑命令。
2. **同名空间歧义拒绝（R2/N2）**：按 name 解析时命中多个空间 → 报错要求改传 id（`the name '…' matches N spaces (ids …); pass the space id instead…`），`close`/`finish` 等不再可能打到「另一个同名空间」；`open` 前也做同名检查（读列表失败不阻塞 open）。**Page 工具与 `ego_app_tabs{scope:'space'}` 现在也接受 `id`（number，优先于 name）**，遇到歧义可直接用 id 定位（0.1.13 N2① 起 `ego_app_space` 也统一为 id 优先）。
3. **调用表达式与带嵌套括号的默认参数（R3，语义澄清）**：`isFunctionSource` 本来就只把**参数列表无嵌套括号**的形式当函数源码——`(async () => 1)()`、`(0, () => 7)()` 都归 expression；`() => 1`、`(a, b) => a`、`function(){…}`、`async () => 1` 仍是函数源码。（0.1.13 的 N4 进一步改为括号匹配：参数带嵌套括号的箭头现在被识别为函数源码，见 0.1.13 节。）
4. **dialog 双错误保留（R4）**：`acceptDialog`/`dismissDialog` 抛错不再抹掉点击错误——两条错误都报（`trigger click failed: …` / `answering the dialog failed: …`）；只有「点击失败但应答成功」时保留 `still answered (handled=…)`；应答本身失败会提示 dialog 可能仍开着（`retry ego_app_dialog without trigger, or reload the Page`）。
5. **app 级 open 不再被诊断性预读阻塞（R5）**：`ego_app_tabs{scope:'app',action:'open'}` 的 `listTabs()` 预读失败时继续 `createTab()`，结果 `verified:null`（预读成功才给 `true`/`false`）——不再因为读不到旧列表就拒绝建 tab。
6. **`1+1;` 真正修好（R6）**：`ego_app_js` 的 auto 判定改用去尾分号后的源码，`{expression:"1+1;"}` 现在走 expression 并返回 `value: 2`（`const x=1; return x;` 仍走 statements）；上一轮「现在可用」的声明从本轮起才属实，测试断言也从 `ok===true` 改为 `value===2`。
7. **结构化成功也能看到脚本/CLI 自身输出（R7/N1）**：结构化工具成功且 CLI 有输出时，结果带 `log`；**ego 不把页面 console 转发到 CLI**，所以 `log` 是脚本或 CLI 自身的输出（页面内 `console.log` 不在其中）；无输出时不出现该字段（结果形状不变）。若此次输出被 `maxOutputBytes` 截断，同一结果还会带 `truncated:true`（未截断不出现）。（0.1.13 N9 起结构化 `log` 上限 16000，超限附 `logTruncated`/`logLength`；`ego_app_run` 不受此限。）
8. **`delete{}` 由宿主侧拒绝（R8）**：没给 name/id/ids → `ok:false`（`… it never guesses which TaskSpace you mean.`）+ hint，**零 spawn**。
9. **delete 的 skipped 与 still-listed 分开报（R9/N5）**：`skippedRunningSpaceIds` 单独文案并**带 hint**（`ego only deletes spaces whose agent task has ended; close or finish them first…`）；只有真的还在列表里才说 `were still listed after ~2400 ms`；两者同时出现时**两条都报**。
10. **`Task space not selected` 专用 hint（R10）**：空间可能已消失 → 先 `ego_app_space{action:'list'}` 确认，否则先 open/use。
11. **轮询常数命名（R11）**：`SPACE_WATCH_INTERVAL_MS = 150` / `SPACE_WATCH_TIMEOUT_MS = 2400`，delete 的 leftover 轮询复用同一常量；文档统一改为「每 150 ms 轮询、2400 ms 截止（实测 17 次 / ~2.6 s）」。0.1.13 N6 起 11 处错误文案也由该常量插值派生（`~${SPACE_WATCH_TIMEOUT_MS} ms`），改常量文案自动跟随。

**文档修正（R12）**：① `12×150 ms` 的旧写法已在 README/CHANGELOG 四处改为「每 150 ms 轮询、2400 ms 截止（实测 17 次 / ~2.6 s）」（0.1.13 N6 起错误文案也由常量插值派生）；② `1+1;` 的声明现由 R6 落实，测试断言为 `value===2`；③ render 的 20000 字符上限是**插件自己的常量**（`OUT.render` 的 limit），不是宿主预算；④ 「任务结束丢输出」的自然命中依赖应用状态，但兜底判定表已由扩展假 CLI 覆盖，不再算「未测的环境限制」；⑤ 0.1.9 close 竞态频率：曾观测 10/13–18/33，复测约 7%（1/14），频率随机器状态浮动，轮询对高频与低频都成立；⑥ `delete{}` 现在也由宿主侧拒绝（0 spawn），「缺 name/id 一律宿主侧报错」对它成立；⑦ app-open 预读失败 → `verified:null`；⑧ 结构化成功可带 `log`（脚本/CLI 自身输出，不是页面 console）；⑨ 同名空间歧义拒绝、Page 工具前导守卫见 R1/R2。

## 行为变化（0.1.11，升级前必读）

0.1.11 是第三轮的收尾版：收掉剩余 S3，把 0.1.10 的 fail-closed 主题补齐到 `ego_app_tabs` / `ego_app_status`，并让生成脚本可以脱离真应用单测。

1. **日志不再吞页面输出（A）**：`log` 只删除本次运行**真正的结果行**——带 token 的运行只删 `@@DSH_RESULT@@<token>` 开头的行；`ego_app_run`（plain）只删与本次选中结果行**完全相同**的那一行。页面自己打印的裸 `@@DSH_RESULT@@...` 会保留在 `log` 里，便于排查「结果行被谁写坏了」。解析顺序不变（哨兵 → onboarding → 退出码 → 纯文本 → 截断）。
2. **读数失败安全化（B/H）**：生成脚本新增 `describeRead()`（try/catch、300 字符截断、不可打印回退 `"(unprintable)"`）。`ego_app_status` 的返回形状固定为 `{version, versionError, profiles, profilesError, tabs, tabsError, tabsSpaceId, spaces}`——`version`/`profiles` 失败改为 `versionError`/`profilesError`，不再把错误对象当数据；`tabs` 读不到时先用「最新 agent 空间」选一次再读（会短暂选择该空间，无其他副作用），成功则 `tabsSpaceId` 记录该空间（只有「选中后重读成功」才出现，不会与 `tabsError` 同时出现），仍失败才给 `tabsError`。
3. **函数源码判定与前置解析（C/T/N-a）**：新增导出 `isFunctionSource()`（只用 `new Function` 解析、不执行函数体）。`ego_app_wait{for:'function'}` 传入完整函数源码时内联为 `(${expr})`，否则仍是旧的 `() => (${expr})`；`ego_app_js` 的 `fn` 参数走 function 模式，`mode:'auto'` 且表达式本身是函数源码时也走 function 模式，显式 `mode:'expression'|'statements'` 绝不自动切换。两处都会先去掉**尾部分号**再判定/包装（`() => 1;` 可用；statements body 保留原样；`1+1;` 的 auto 判定由 0.1.12 的 R6 才真正修好），并在 **spawn 前**解析源码：语法错误直接可读失败（`needs a valid function source or expression` / `… is not valid JavaScript`），不 spawn、零副作用。顺带修掉 `ego_app_js{expression:"() => 1+1"}` 以前被包成 `() => (() => 1+1)`、返回值是函数、JSON 里 `value` 静默消失的问题（现在返回 `2`）。
4. **终态/移交动作先取值（D）**：`ego_app_page{action:'close'}` 关闭前先取 `page.label`；`close`/`finish`/`complete`/`mark_error`/`handoff`/`takeover`/`wait_control` 脚本开头先取 `task.spaceId`，之后只用它——动作把 label/spaceId 变成 `undefined` 也不再丢结果字段。用户数据（selector、文件路径等）里的同名字面量不会被改写。
5. **`create` 无 id 报错（F）**：`createTaskSpace()` 没有返回 space id 时直接报 `createTaskSpace() did not return a space id: …; no space was selected`，不再 `useTaskSpace(undefined)` 后静默失败。
6. **`dialog` 行为补全（G/N）**：`waitMs` 负数/NaN → `0`、上限 `30000`，且 `waitForTimeout` 用 try/catch 包住——点击已发生也一定继续应答 dialog，不再出现「alert 未应答卡 15 s」；`promptText:""` 现在会真的传空串（只有缺省才表示不传）；结果带 trigger 的 `receipt`，`handled:false` 带 `note`（确认没有可应答的 dialog）；trigger 点击本身抛错时**仍会先应答 dialog**，然后才抛点击错误（错误里带 `any dialog it raised was still answered (handled=…)`），不会留下未应答的 dialog。
7. **`ego_app_tabs` 与 space 列表证据（I/J/K/L/M/U/N-c/N-d/N-e）**：`scope:'space'` 结果带 `targetId`/`openedBy`；`scope:'space',action:'open'` 带 `opened`；`scope:'app',action:'open'` 带 `created`（`createTab()` 返回值的可读字符串），并注意 **app 的 open 也会在当前空间新增一个 managed Page、消耗 ego 每空间 8 页预算**。`scope:'app',action:'open'` 还会多带 `verified:boolean|null`（tab 列表是否真的变长——只是证据，不因 `false` 报失败，避免列表刷新竞态；预读失败时为 `null`，0.1.12 起仍继续创建）。`open_page` 没有返回带 label 的 Page → 失败；`pages`/`tabs`/`adopt`/`release` 的 `task.pages()`/`task.tabs()` 不是数组 → 可读失败（`the TaskSpace page/tab list is unreadable`）；`adopt` 返回页后会回读 `task.pages()` 给出 `verified:boolean`（是否真的被 agent 管理）；`user_page` 兼容同步/异步 `task.userPage()`；`ego_app_tabs` 的空白 `name` 视同未给。
8. **`ego_app_page{action:'fetch'}`（O）**：`options.saveAs` 会回显为 `saveAs`——工具与参数描述现在是「ego writes the file; the path is echoed back but not verified」，文件由 ego 负责写入，本调用**不验证**文件是否真的存在。
9. **`ego_app_gesture`（P）**：API 什么都没返回时 `shown:null`（以前 `undefined` 也会报 true），`detail` 截断 500。
10. **`describeReceipt`（Q）**：dialog 的 `message`/`defaultPrompt` 等页面可控文本截断 2000 并标注 `…[truncated N chars]`，避免页面文本撑爆回执。
11. **`ego_app_run` 的 `truncated`（R）**：结果行完整、但输出尾部被截断时，结果也带 `truncated:true`；exit≠0 的诊断顺序不变（退出码优先于截断）。
12. **新 hint（S）**：tab 读失败有专用 hint（`would not list its tabs…`，不再把 caller 指向 TaskSpace 列表）；adopt/release 与「每空间 8 页」Page budget 也各有 hint。
13. **未闭合引号仍按纯 CSS（保守）**：`[data-x="a>>b]` 这类引号未闭合的写法不猜成 ego locator，仍作为纯 CSS 交给 `querySelector`，由测试锁死——宁可查不到，也不把合法 CSS 误判成 locator。
14. **真浏览器 live 套件必须串行**：ego 的「当前选中 space/page」是应用级全局状态；两个会话/两个进程并发跑 live 套件会串页（0.1.9 轮曾实测到一次假红）。`npm run test:live` 请在同一会话里串行执行。

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
9. **render 截断有标记**：结果超过 20000 字符时显示 `…[renderedTruncated omittedChars=N limitChars=20000]`，不再静默截断。**20000 是插件自己的常量**（`OUT.render` 的 `limit`），不是宿主预算——这是我们的选择。
10. **新 hint**：`no space with id`、`only removes user-owned`、`matches N spaces`、`could not be read|could not be verified` 等失败都带下一步建议。

## 行为变化（0.1.9）

0.1.9 让失败结论也有实测依据，因此有三处会直接影响调用方式的变化：

1. **动作可能「转换成功之后仍返回 `ok:false`」**：`close`/`finish`/`complete`/`mark_error`/`handoff`/`wait_control` 都会轮询回读真实状态（每 150 ms 轮询、2400 ms 截止；实测 17 次 / ~2.6 s）。动作本身可能已经落地，但状态在轮询窗口内没到位 → 仍返回 `ok:false`。看到 `ok:false` 先读 `error` 里的实测状态（`observed ownership=…`、`was still listed after … ms`）和 `hint`，**不要盲目重试**：先用 `ego_app_space{action:'list'}` 确认现状，空间已经不在就说明动作其实生效了。
   **任务结束导致输出被丢弃（新兜底）**：ego 在「动作触发的任务结束」时会 hard-stop 脚本并**丢弃已缓冲输出**（连结果哨兵一起丢），CLI 只打印 `This task space is no longer assigned to the agent: its task has ended … browser commands are paused` 并以 0 退出。旧版会把这种**其实已经成功**的 `close` 报成「脚本没跑」。现在 `ego_app_space` 的 `close`/`finish`/`complete`/`mark_error`/`handoff`/`wait_control`/`takeover` 命中该通知时，会用一次独立的只读 `listTaskSpaces()` 复核再下结论（只在「命中通知且原本判失败」时触发，正常路径仍返回 ego 原生回执）：终结类动作可能返回 `{ok:true, …, receipt:null, verifiedBy:"listTaskSpaces", note:"…"}`——**`receipt:null` 不是失败**（回执被 ego 丢了，结论来自独立复核；`finish` 在该路径上 `keep` 也是 `null`）；空间不在列表 → `ownership:"closed"`，仍在列表但 `ownership` 是 `user` → 对 `finish(keep:true)`/`complete`/`mark_error` 也算成功。`handoff`/`takeover`/`wait_control` 若复核到**目标态已经达成**（分别是 `agentDelegatedToUser`/`agent`/`agent`）同样返回 `ok:true`（`handedOff`/`tookOver`/`control` + `verifiedBy`），不会因为脚本没跑完就把已达成的状态判失败；空间已消失时这三个仍失败。**按 name 寻址且空间已消失时，兜底结果的 `spaceId` 是 `null`**（插件拿不到 id；只有按 id 传入时才回显）——`spaceId:null` + `verifiedBy:"listTaskSpaces"` 是成功，不是缺字段。两个例外：`finish{keepPages:[...]}` 命中该通知时**不走兜底**（page 级结果无法用空间列表验证，保留原始失败）；`finish(keep:false)` 在这条路径上若空间仍以 `user` 列出则**失败**（要关掉却没关掉，hint 指向按 id `delete` 或面板关闭）。
2. **除 `open` 外的空间动作不再创建空间**：官方 `taskSpace(name)` 是「reuse **or** create」，所以旧版「close 失败 → 重试 close」会静默新建同名空间再关掉、返回假成功。现在只有 `open` 会创建；`close`/`finish`/`delete` 等在名字或 id 不存在时直接报 `… is currently open. This action only operates on an existing space; it never creates one.`。**空间动作（含 `open`；`list`/`create` 除外）必须显式给 `name` 或 `id`**——空白 name（如 `"   "`）等同于缺省，`delete{}` 也从 0.1.12 起由宿主侧直接拒绝（零 spawn）——否则宿主侧直接报 `name (string) or id (number) is required for this action`（附 hint、零副作用）——这是故意的安全设计，避免误关/误改最新空间；只有 page 工具（`ego_app_navigate`/`snapshot`/`click`/`fill`/…）可以省略 name，取最新的 agent 空间（没有则取最新的 `agentDelegatedToUser` 空间）。
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
7. **`agentDelegatedToUser` 空间（交还控制后）没有 API 能关闭**：`closeTaskSpace`/`claimTaskSpace`/`deleteSpaces` 均返回成功但不生效。需在 ego 面板手动关闭，或让用户先交还控制。**0.1.9 起 `close` 会轮询空间列表**（每 150 ms 轮询、2400 ms 截止；实测 17 次 / ~2.6 s）直到 id 消失：正常关闭不再被误报成失败；只有 ego 明确拒绝（回执带 `error`，如空间已委派）、轮询后仍列出、或列表读不出来才 `ok:false`（读失败时错误带 `observed ownership: unreadable`，不会被当成「已关闭」），错误里带实测 `ownership` 与 hint（不再断言「这是委派给用户的空间」）。别用「重试 close」当解法——除 `open` 外的动作不会创建空间，重试只有在空间确实还在时才有意义。
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

0.1.16 的实跑状态：`npm test` **133/133**、`live-e2e` **89/89**、`pointer-selector` **11/11**（见 [run log](docs/TEST-RUN-2026-11-03-0.1.16.md)）。

- `npm test` —— 不需要 ego lite，**133** 项：`cli-outcome`、`output-collector`、`locator-detect`、`ended-task-outcome`、`generated-scripts` + `test/fake-cli/nodejs`（假 ego CLI 断言生成脚本：R1–R11、N1/N2/N5、N4/N6/N7/N9/N2①、0.1.15 的 oracle/probe 契约、0.1.16 的 P14–P25——行终止符、函数值 marker 不可伪造、`fn:`/`mode:`/`arg` 拒绝、wait 空源文案、参数白名单、gesture 坐标、finish keepPages）。`test/function-source.test.mjs` 已随 `isFunctionSource` 一并移除。
- `npm run test:live` —— 需要 ego lite 在运行、已完成 onboarding；**真浏览器套件必须串行跑**（ego 的「当前选中 space/page」是应用级全局状态，并发会串页）。
  - `test/live-e2e.mjs`（89 项）：动作回执、下载、文件选择器、快照、粘贴、指针，以及 0.1.9–0.1.13 的回读/fail-closed/`pageCreated`/abort/nonce/函数源码等；0.1.14 增补带注释/关键字 regex 的谓词被判为裸函数源码、带注释的 false 谓词在 600 ms 下必须超时失败。
  - `test/pointer-selector.mjs`（11 项）：`mouse_click` 只接受 x/y 或纯 CSS 选择器，ref/loc= 必须报错而不是点 (0,0)。

0.1.16 的实测记录见 [docs/TEST-RUN-2026-11-03-0.1.16.md](docs/TEST-RUN-2026-11-03-0.1.16.md)；历史日志：
[docs/TEST-RUN-2026-11-01-0.1.15.md](docs/TEST-RUN-2026-11-01-0.1.15.md)（0.1.15）、
[docs/TEST-RUN-2026-11-01-0.1.14.md](docs/TEST-RUN-2026-11-01-0.1.14.md)（0.1.14）、
[docs/TEST-RUN-2026-11-01-0.1.13.md](docs/TEST-RUN-2026-11-01-0.1.13.md)（0.1.13）、
[docs/TEST-RUN-2026-11-01-0.1.12.md](docs/TEST-RUN-2026-11-01-0.1.12.md)（0.1.12）、
[docs/TEST-RUN-2026-11-01-0.1.11.md](docs/TEST-RUN-2026-11-01-0.1.11.md)（0.1.11）、
[docs/TEST-RUN-2026-11-01-0.1.10.md](docs/TEST-RUN-2026-11-01-0.1.10.md)（0.1.10）、
[docs/TEST-RUN-2026-11-01-0.1.9.md](docs/TEST-RUN-2026-11-01-0.1.9.md)（0.1.9）、
[docs/TEST-RUN-2026-10-31.md](docs/TEST-RUN-2026-10-31.md)（0.1.1–0.1.3）、
[docs/TEST-REPORT.md](docs/TEST-REPORT.md)（0.1.0 时代的 19 工具报告：正文 95/95、附录 A.3「99 项」是历史口径，**不是当前套件的计数**）。

测试页在 `test/fixtures/interaction.html`（带点击坐标捕获），可用 `EGO_E2E_FIXTURE` 指向别处；
ego lite 未运行时两个 live 套件会打印 SKIP 并以 0 退出；CI 里设 `EGO_E2E_REQUIRE=1` 则改为失败退出。
注意参数校验的两种错误形态：`ego_app_download` 缺 `saveAs` 由宿主直接抛 `ToolArgsError`（schema 必填），
其余工具的错误都以 `{ok:false, error}` 返回。

## 许可

MIT。ego lite 本体（Citro Labs）不在本仓库内，也不随本包分发。
