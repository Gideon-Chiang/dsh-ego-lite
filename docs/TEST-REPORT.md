> **历史记录（0.1.0 时代）**：本文是最初 19 个工具的矩阵（2026-10-30，另一台机器），行号与文件规模均以当时的源码为准。
> 当前版本的能力与回归请看 `docs/TEST-RUN-2026-10-31.md` 与 `npm run test:live`。

# dsh-ego-lite 插件测试报告

- 生成时间：2026-10-30 15:57 (Asia/Shanghai)
- 被测对象：`C:\Users\BL\.dsh\local-plugins\dsh-ego-lite\lib\index.js`（43,991 字节）
- 实际加载路径：`C:\Users\BL\.dsh\profiles\web\node_modules\dsh-ego-lite\lib\index.js`（pnpm 复制副本）
- 运行环境：DSH web（profile `web`）+ ego lite 0.6.2.5（Chromium 156，profile「姜金豆」）
- 测试页面：`C:\Users\BL\dsh-ego-test\server.mjs`（`http://127.0.0.1:8899/`，表单/下拉/多行/弹窗/文件/拖拽/长页面/第二页）
- 测试脚本：`C:\Users\BL\dsh-ego-test\matrix.mjs`（通过 `tool.execute()` 走与宿主完全相同的注册与参数校验路径）

## 结论

**95 / 95 用例通过**（最终轮，全部代码为修复后的最新版本）。平均单次调用 ≈ 0.7 s，最慢常规用例 ≈ 3.3 s（`ego_app_key paste`，走系统剪贴板），`wait_control` 用例 25 s 为故意等待超时。

过程中发现 **12 个问题**：11 个已修复，1 个属于 ego 运行时语义限制（`agentDelegatedToUser` 空间无法程序化关闭），已记录规避方式。

## 测试清单与结果

| 组 | 用例数 | 覆盖内容 | 结果 |
|---|---|---|---|
| S 状态 | 3 | status 可用性、open 后 status 结构、spaces/profiles 字段 | 3/3 |
| A 空间生命周期 | 20 | open（含幂等）、list、pages、tabs、open_page、adopt（含无效 label）、release 拒绝、user_page、set_state、create（自动 use）、use、mark_error、complete、keepPages 校验、finish、结束空间再 open 的 claim 提示、delete 边界 | 20/20 |
| B 导航/观察 | 5 | 正常跳转、跨页跳转、回退、不可达 URL 报错、快照（viewport / full_page）、截图（指定路径 / 默认临时目录） | 5/5 ＋ 观察 4/4 |
| C 交互 | 27 | fill（中文/多行）、select（label/value/index）、click（含 label/无效选择器）、hover、dblclick、drag、scroll、move、mouse_click、mouse down/up、focus、press（带/不带选择器）、type、insert_text、paste、upload、file_chooser 超时 | 27/27 |
| D 等待 | 10 | waitForSelector、load_state、function、timeout、url（异步跳转触发）、不存在元素超时、wait_event 校验 | 10/10 |
| E 脚本/协议 | 7 | js 表达式、js 函数+参数、js 语句体+return、CDP page、CDP task、CDP app、page.fetch | 7/7 |
| F 对话框/页面 | 5 + 4 | alert accept、prompt accept（带文本）、confirm dismiss（含结果断言）、reload、events、close page、页数复核 | 9/9 |
| G 元能力 | 6 | 鼠标高亮、手势、run 脚本+日志捕获、空脚本拒绝、app tabs、space tabs open | 6/6 |
| H 交还控制 | 4 | handoff、交还后命令暂停、wait_control 超时、提示正确 | 4/4 |

失败用例（最终轮）：0。

## 发现的问题与处理

| # | 问题 | 影响 | 处理 |
|---|---|---|---|
| 1 | `dsh plugin add file:` 是**复制**而非软链（profile 副本 12,487 B，源码已 41 KB） | 改源码完全不生效，重启也还是旧代码 | 部署流程改为「改源码 → 复制到 profile 副本 → 重启」；本轮已同步 |
| 2 | 插件**没有热加载**，新增工具必须重启 dsh | 上一轮"重启即生效"的说法只在副本已同步时成立 | 已写入流程；本会话仍是旧 4 工具，需再重启一次加载 19 工具 |
| 3 | `adopt` 在 label 不匹配时回退到 active tab | 会误接管别的标签页 | 仅当未传 page 时才回退 active |
| 4 | `selectOption` 传数字 index 被运行时拒绝 | 按序号选择一直失败 | 改为 `{ index: n }` 对象 |
| 5 | `file_chooser` 分支在重构中丢失，静默落到 `reload` | 工具"成功"但做错事 | 补回分支 |
| 6 | `waitForEvent` 仅支持 popup / download | 传 load 之类得到底层 TypeError | 预校验 + 明确提示（ego 限制） |
| 7 | `waitForFunction` 第二参必须显式 `undefined` | 等待函数恒报参数错误 | 已修 |
| 8 | `finish` 的 keepPages 含不存在标签时报底层 `page label not found` | 排查成本高 | 预校验并列出可用页 |
| 9 | 对话框跨调用会被自动关闭，`acceptDialog` 实际返回 false 却恒报 `handled:true` | 假的成功 | 新增 `trigger` + `waitMs`，同一次调用内点击并应答；`handled` 取真实返回值 |
| 10 | `deleteSpaces` 传 agent-owned id 会**挂死**（>90 s 无响应） | 清理测试空间时每次卡满超时 | 先查归属并返回可读错误（提示 close/finish），新增 `force` |
| 11 | 未指定 name 时 space 前导会**顺手新建**一个空间 | 只读操作产生副作用垃圾空间 | 改为报错提示先 `open` |
| 12 | 首轮 33 个 FAIL 源于本地测试服务未启动（页面是 `chrome-error`） | 全是环境噪音，差点误判为插件缺陷 | 矩阵前置 `curl` 校验 200 后再跑 |

## 复现方式

```powershell
# 1) 起测试页（保持前台或另开窗口）
node C:\Users\BL\dsh-ego-test\server.mjs

# 2) 确认 200 再跑矩阵
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:8899/
cd C:\Users\BL\.dsh\profiles\web
node C:\Users\BL\dsh-ego-test\matrix.mjs

# 3) 结果
#   控制台 PASS/FAIL 逐条
#   C:\Users\BL\dsh-ego-test\matrix-result.json（含每条 args / 耗时 / 返回样本）
```

## 仍未覆盖 / 已知限制

1. **CDP 事件订阅**：`ego.onCDPMessage` / `ego.onSendCDPMessageError` 是流式回调，没有做成请求型工具；需要时在 `ego_app_run` 里挂监听或轮询 `ego_app_page{events}`。
2. **`wait_control` 需要真人**：只能在 ego UI 里点"归还控制"；测试以 25 s 超时验证了阻塞语义。
3. **`agentDelegatedToUser` 空间无法程序化关闭**：`close` 返回 ok 但空间仍在（本机残留 id 8/13/18/25）。需在 ego 的 Space 面板手动关闭，或由用户先归还控制再 close。
4. **`page.fetch` 受浏览器 CORS 约束**：跨源会失败，这是 ego 语义而非工具缺陷。
5. **app 级 `listTabs` 需要已选中空间**：未选中时返回 `{error:"Task space not selected"}`，`ego_app_status` 会原样透出。
6. **批量删除慢**：一次删 3 个以上容易逼近超时，建议 ≤3 个一批（与问题 10 同源）。
7. **`ego.snapshot`（应用级）** 未单独暴露：任务页快照已由 `ego_app_snapshot` 覆盖。

## 交付物

- 插件源码：`C:\Users\BL\.dsh\local-plugins\dsh-ego-lite\lib\index.js`
- 挂载：profile `web` 的 `dependencies` + `dsh.profile.bundles` 均含 `dsh-ego-lite`
- 测试资产：`C:\Users\BL\dsh-ego-test\{server.mjs, matrix.mjs, matrix-result.json, upload.txt, shot-viewport.png}`

---

# 附录 A：会话内复测（第三次重启后，18:14 起）

前面 95 项是「宿主同源调用」（`tool.execute()` 直调）。本轮补上**真的从会话里调用已注册工具**这条路径，发现两个只在会话内才会暴露的问题。

## A.1 会话内通过的检查

| 检查 | 结果 |
|---|---|
| 19 个工具是否注册进会话 | ✅（`ego_app_dialog` 等新工具已可调用） |
| `ego_app_status` 返回 version / profiles / spaces | ✅ |
| `ego_app_space{open}` 建空间 | ✅ id=2，pages=[p1] |
| `ego_app_navigate` 打开测试页 | ✅ title=DSH Ego 测试页 |
| `ego_app_snapshot`（含 `ref=N` 定位符） | ✅ |
| `ego_app_fill` 用 `ref=1` 填中文 | ✅ 8 字节 |
| `ego_app_select{index:1}`（修复项） | ✅ 选中 Beta |
| `ego_app_click` 用 `ref=6` | ✅ |
| 页面结果断言 `HI 张伟 会话内测试 / b` | ✅ |
| `ego_app_dialog{trigger:"#alertBtn"}` | ✅ handled=true |
| `ego_app_dialog{trigger:"#promptBtn",promptText:"张伟"}` | ✅ 页面出现 `PROMPT 张伟` |
| `ego_app_screenshot` 指定路径落盘 | ✅ |
| `ego_app_cdp{scope:"task"}` Target.getTargets | ✅ 返回 10 个 target（含你自己的 CTF 标签，未被动过） |
| `ego_app_tabs{scope:"space"}` | ✅ |
| `ego_app_key` 全局 `ControlOrMeta+A` | ✅ |
| `ego_app_pointer{scroll}` | ✅ |
| `ego_app_snapshot{scope:"full_page"}` | ✅ 120 段全文 + 已填内容 |
| `ego_app_space{open_page}` → p2 → `ego_app_page{close}` | ✅ |
| `ego_app_page{reload}` / `ego_app_gesture` | ✅ |
| `ego_app_space{finish, keepPages:["p1"]}` | ✅ 空间转 user-owned |

## A.2 会话内专属问题

| # | 问题 | 处理 |
|---|---|---|
| 13 | 错误返回对象里带 `stderr: undefined`，宿主校验报 `value is not lossless JSON`（矩阵用 `JSON.stringify` 比较，掩盖了它） | 增加 `lossless()` 过滤 undefined 字段，5 处返回点全部套用；已验证 adopt/keepPages/file_chooser/run 的错误返回均为 lossless |
| 14 | `delete` 走空间前导，导致**没有 agent 空间时无法删除已完成空间**（我加归属校验时引入的回归） | `delete` 不再依赖前导，只按 `ids` 或 `name` 定位；已实测在「零 agent 空间」状态下删除成功 |
| 15 | 测试用例对真实浏览器发右键 `mouse.down/up`，**弹出原生上下文菜单**（你看到的现象） | 已发 Escape + 空白处点击关闭；用例改为左键验证 API，右键改为先注入 `contextmenu` preventDefault 再断言事件到达页面 |

## A.3 会话内矩阵（合并后）

`matrix.mjs` 增至 **99 项，99 通过**（新增 C17b–C17e：右键事件在 preventDefault 下正确到达页面且不弹菜单）。

## A.4 仍待一次重启

会话内**错误路径**（adopt 无效 label、keepPages 不存在、file_chooser 超时、open 已结束空间、delete 守卫）当前仍运行修复前的返回结构，会复现问题 13。代码已部署（44,665 字节），重启后即可闭合这批用例。

## A.5 无法程序化清理的残留

`agentDelegatedToUser` 空间（现为 id 7、12、17）`close` 返回 ok 但不会被移除，需在 ego 的 Space 面板手动关闭。

