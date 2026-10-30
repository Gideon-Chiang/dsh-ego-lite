# Changelog

## 0.1.0 — 2026-10-31

首个公开版本。

- 19 个 `ego_app_*` 工具，覆盖 ego lite agent 控制面：app 级（版本/Space/标签/profile/手势/CDP）、TaskSpace 生命周期、Page 操作（导航、快照、截图、点击、填表、键盘、指针、下拉、等待、求值、CDP、对话框、上传、文件选择、fetch、事件）。
- 通过官方 `ego-browser nodejs` 执行：脚本写入 UTF-8 `.mjs`，用 `-e "await import('file:///…')"` 入口，避免 shell 引号与编码问题。
- 结果走 `@@DSH_RESULT@@` 哨兵解析（ego 的 `console.log` 走 stderr，双流扫描）。
- 所有返回对象经 `lossless()` 过滤 undefined，避免宿主拒绝非无损 JSON。
- 显式处理 ego 语义边界：`finish` 的 `keep` 形态、交还控制后命令暂停、`createTaskSpace` 需 `useTaskSpace`、新建空间无 `p1`、`deleteSpaces` 只删 user-owned、delegated 空间不可程序化关闭、对话框需同调用内应答。
- 99 项测试矩阵通过（含会话内实测）：页面交互、等待、CDP、对话框、Space 生命周期、交还控制。
