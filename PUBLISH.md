# 发布清单（dsh-ego-lite 0.1.0）

本文件记录发布所需的全部步骤与当前状态。仓库内容已就绪，只差两步需要账号授权。

## 当前状态

| 项 | 状态 |
|---|---|
| 发布包内容（`npm pack`） | ✅ 8 个文件 / 22.5 kB，`lib`、`cordis.patch.yml`、README、LICENSE、CHANGELOG、docs |
| 干净环境安装验证 | ✅ 在临时项目 `npm install <tgz>` 后 `import('dsh-ego-lite')` 成功注册 19 个工具 |
| npm 包名可用性 | ✅ `dsh-ego-lite` 在 registry.npmjs.org 返回 404（未占用） |
| git 仓库 | ✅ `main` 分支已提交，remote 指向 `git@github.com:Gideon-Chiang/dsh-ego-lite.git` |
| GitHub HTTPS | ❌ 连接被重置（本机网络），改用 SSH |
| GitHub SSH | ⚠️ 能连通，但公钥尚未加到 GitHub 账号 |
| npm 登录 | ❌ 本机无 token / 未 `npm login` |

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
cd C:\Users\BL\dsh-ego-lite
git push -u origin main
```

## 第 3 步：发布到 npm

方式 A（交互登录，推荐本人操作）：

```powershell
npm login                     # 浏览器授权
cd C:\Users\BL\dsh-ego-lite
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
dsh plugin --profile web add file:C:/path/to/dsh-ego-lite-0.1.0.tgz
```

安装后重启 dsh（插件不热加载；profile 内是物理副本，改源码后需重新复制）。

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
