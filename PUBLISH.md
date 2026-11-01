# 发布清单（dsh-ego-lite）

本文件记录发布所需的全部步骤与当前状态。仓库内容已就绪，只差两步需要账号授权。

> 本轮版本 **0.1.14**（2026-11-01）。正文表格里的 0.1.0 状态与「19 个工具」是最初发布的记录，保留作为流程底稿；
> 当前仓库在 `E:\Work-Project\DSH_Research\my-dsh-plugins\dsh-ego-lite`，工具数为 **20**（0.1.1 起新增 `ego_app_download`）。

## 当前状态

| 项 | 状态 |
|---|---|
| 发布包内容（`npm pack`） | ✅ 8 个文件 / 22.5 kB，`lib`、`cordis.patch.yml`、README、LICENSE、CHANGELOG、docs（0.1.0 实测） |
| 干净环境安装验证 | ✅ 在临时项目 `npm install <tgz>` 后 `import('dsh-ego-lite')` 成功注册 19 个工具（0.1.0；0.1.1 起为 20 个） |
| npm 包名可用性 | ✅ `dsh-ego-lite` 在 registry.npmjs.org 返回 404（未占用） |
| git 仓库 | ✅ `main` 分支已提交，remote 指向 `git@github.com:Gideon-Chiang/dsh-ego-lite.git` |
| GitHub HTTPS | ❌ 连接被重置（本机网络），改用 SSH |
| GitHub SSH | ✅ 已验证（`ssh -T git@github.com` → Hi Gideon-Chiang） |
| npm 登录 | ✅ 账号 gideon-chiang；0.1.2 起发布改用 bypass-2FA granular token（见下） |

## 第 1 步：GitHub 授权（一次性）

本机已生成专用密钥 `~/.ssh/id_ed25519_github`，并在 `~/.ssh/config` 里为 github.com 配置了 `IdentitiesOnly`。

1. 复制公钥：

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFay0Cc9UNRtaUpMgFFdcOZpsn86h8Y1ZIeEZCGDb0X dsh-ego-lite
```

2. 打开 https://github.com/settings/ssh/new ，Title 填 `dsh-ego-lite (Windows)`，粘贴公钥，保存。
3. 在 https://github.com/new 创建**空仓库** `dsh-ego-lite`（不要勾 README / .gitignore / license，否则首推会冲突）。

验证：

```powershell
ssh -T git@github.com     # 期望：Hi Gideon-Chiang! You've successfully authenticated...
```

## 第 2 步：推送到 GitHub

```powershell
cd E:\Work-Project\DSH_Research\my-dsh-plugins\dsh-ego-lite
git push -u origin main
```

## 第 3 步：发布到 npm

方式 A（交互登录，推荐本人操作）：

```powershell
npm login                     # 浏览器授权
cd E:\Work-Project\DSH_Research\my-dsh-plugins\dsh-ego-lite
npm publish
```

方式 B（用 token，非交互）：

```powershell
# 在 https://www.npmjs.com/settings/~/tokens 生成 Automation token
$env:NPM_TOKEN = "npm_xxx"
.\scripts\publish.ps1
```

发布后验证：

```powershell
npm view dsh-ego-lite version
curl.exe -s https://registry.npmjs.org/dsh-ego-lite | Select-Object -First 1
```

## 第 4 步：让别人安装

```powershell
# 从 npm
dsh plugin --profile web add dsh-ego-lite

# 从 GitHub
dsh plugin --profile web add github:Gideon-Chiang/dsh-ego-lite

# 本地 tarball
dsh plugin --profile web add file:C:/path/to/dsh-ego-lite-<version>.tgz
```

安装后重启 dsh（插件不热加载；profile 内是物理副本，改源码后需重新复制）。

## 0.1.2 发布实录（2026-10-31，实测可行的路径）

踩过的坑，按顺序记下来省时间：

1. **普通非交互 `npm publish` 会 403**：`Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.`
   这个 403 **与 OTP 无关**——用假码 `--otp=000000` 试探，返回的是同一条错误，说明是 token 能力问题，不是验证码问题。
2. **npm 的 2FA 是邮件 OTP，且是 8 位**（不是通常以为的 6 位），发到账号邮箱。登录/改账号时可能还需要输入账号密码。
3. **CLI 的 web 登录**（`npm login --auth-type=web`）会给出一个 `https://www.npmjs.com/login?next=/login/cli/<uuid>`：
   在已登录 npm 的浏览器里打开它 → 会跳到 `/escalate/otp` 要邮件 OTP → 填对后页面显示 **Authentication Successful**，
   CLI 打印 `Logged in on https://registry.npmjs.org/.` 并把新 session token 写进 `~/.npmrc`。
   注意：**这个 session token 仍不足以直发**（照样 403）。
4. 真正能直发的是网页上手工生成的 **Granular Access Token + 勾选 Bypass 2FA**：
   <https://www.npmjs.com/settings/gideon-chiang/tokens/granular-access-tokens/new>
   - Token name / Expiration（默认 7 天）
   - Packages and scopes → **Read and write (publish and stage)** → **All packages**
   - **Bypass two-factor authentication (2FA)** 勾上
   - 生成前需要**再输一次账号密码**确认（浏览器里本人操作即可，agent 不需要拿到密码）
5. 用它发布，事后立刻删掉临时 npmrc：

```powershell
# token 只写进临时 userconfig，别进仓库
"//registry.npmjs.org/:_authToken=<TOKEN>" | Set-Content .npmrc.publish -Encoding ascii
npm publish --userconfig .npmrc.publish
Remove-Item .npmrc.publish
```

6. ⚠️ npm 公告：bypass-2FA token 的**直发能力将在 2027-01 移除**（页面横幅：
   "npm tokens that bypass 2FA ... direct publishing (Jan 2027)"）。届时改用
   **Read and write (stage only)** + 网页审批的 staged publishing，或升级到支持 `npm stage` 的 npm 版本
   （本机 npm 11.9.0 尚无 `npm stage` 子命令）。
7. 发布后 registry 有几分钟传播延迟，`npm view` 可能仍返回旧版本；用
   `curl -s https://registry.npmjs.org/<pkg> | ...` 轮询可见。

## 后续版本

```powershell
npm version patch          # 0.1.0 -> 0.1.1，自动打 tag
git push --follow-tags
npm publish
```

## 已知限制（发布说明里已写明）

- ego lite 应用必须已安装、已完成 onboarding 并正在运行。
- `agentDelegatedToUser` 状态的空间无法通过任何 API 关闭，需在 ego 面板手动关闭。
- `wait_control` 需要真人在 ego 界面交还控制。
- 本包不包含 ego lite 本体，也不随包分发其代码。
