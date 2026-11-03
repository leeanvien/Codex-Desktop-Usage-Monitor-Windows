# 上传 GitHub 与发布版本

本分享版准备使用的仓库是 `leeanvien/Codex-Desktop-Usage-Monitor-Windows`。本地打包不会替你创建仓库、提交代码或发布 Release。

## 一、生成分享文件

准备 Node.js 22+ 后，在项目根目录运行；第一次从源码构建先安装测试依赖：

```powershell
npm ci
pwsh -NoProfile -File .\scripts\build-github-share.ps1
```

构建先执行完整测试，再按白名单导出当前版本，默认输出到 `dist/github-share-v<版本号>`。目录已存在时不会覆盖；可以用 `-OutputDirectory` 指定新的输出目录。

以 v3.2.13 为例，输出内容如下：

| 文件或目录 | 用途 |
| --- | --- |
| `source/Codex-Desktop-Usage-Monitor-Windows/` | 上传到 GitHub 仓库的源码，包含隐藏的 `.github`、`.gitignore`。 |
| `codex-usage-monitor-windows-3.2.13.zip` | 给使用者下载、解压后运行 `install.ps1` 的安装包。 |
| `codex-usage-monitor-windows-3.2.13-source.zip` | 源码备份 ZIP；解压后内容与上述源码目录相同。 |
| `SHA256SUMS.txt` | 两个 ZIP 的 SHA-256 校验值。 |
| `RELEASE_NOTES.md` | 可复制到 GitHub Release 描述的文字。 |
| `上传说明.md` | 本说明的副本。 |

源码与安装包均不包含原工作目录的 `.git`、`node_modules`、`artifacts`、`output`、旧版本安装目录、用户设置、会话日志或凭据。保留 `LICENSE`、`NOTICE.md` 和 README 中的上游来源。

## 二、创建公开仓库并上传源码

1. 登录你提供的 GitHub 账号 `leeanvien`，点击右上角 `+` → **New repository**。
2. 仓库名填写 **Codex-Desktop-Usage-Monitor-Windows**，选择 **Public**。本地已经提供 README、许可证和 `.gitignore`，新建时不必额外初始化这些文件。
3. 在新仓库选择 **uploading an existing file**，或 **Add file → Upload files**。
4. 打开打包结果中的 `source/Codex-Desktop-Usage-Monitor-Windows`，把其中的全部文件及文件夹拖入上传区域。上传的是目录内的内容，而不是外面这一层目录，也不要只上传源码 ZIP。
5. 确认根目录能看到 `README.md`、`install.ps1`、`assets/`、`scripts/`、`tests/`、`config/`、`docs/` 和 `.github/workflows/`，提交说明填写 `Publish v3.2.13` 后提交到 **main**。

若网页不便上传隐藏目录，可用 GitHub Desktop 的 **Add local repository** 打开上述干净源码目录，创建 Git 仓库后选择 **Publish repository**。不要选原先包含历史安装与个人调试记录的工作目录。

## 三、发布供大家下载的安装包

1. 打开刚创建的仓库右侧 **Releases → Draft a new release**。
2. 新建标签 **v3.2.13**，Target 选择 **main**；标题填写 `Codex Usage Monitor for Windows v3.2.13`。
3. 把 `RELEASE_NOTES.md` 的正文复制进描述。
4. 在附件区域上传安装 ZIP、源码 ZIP 和 `SHA256SUMS.txt`。文件名保持不变；不要上传 `source/` 目录、测试日志或个人配置。
5. 正式发布时不要勾选 **pre-release**，然后点击 **Publish release**。使用者应下载安装 ZIP，而不是 GitHub 自动生成的 `Source code (zip)`。

项目也提供标签发布工作流。推送 `v<版本号>` 标签时，GitHub Actions 会重新测试、构建并上传这两个 ZIP 与对应校验清单；已有同名 Release 时会一并更新三个附件，保持校验清单与 ZIP 一致。

## 四、自动更新来源与以后发布

此分享包的下载链接、更新元数据地址以及下载 URL 校验均指向：

```text
https://github.com/leeanvien/Codex-Desktop-Usage-Monitor-Windows
```

尚未创建仓库或正式 Release 时，检查更新可能失败，但继续使用当前版本。使用者的自动更新默认关闭。开启后仍保留每 24 小时检查、正式版本、精确 ZIP 名、GitHub SHA-256、路径/大小校验和定制功能保留检查；不会回到原作者仓库下载覆盖版。

如果最终使用不同的用户名或仓库名，发布前先修改 `scripts/auto-updater.mjs` 的 `RELEASE_API_URL`、`REPOSITORY_PATH`，同步 README 与 `tests/auto-updater.mjs`、`tests/auto-update-worker.mjs` 中的仓库地址，再重新打包。不要只重命名 ZIP。

以后发布新版本时，一起更新 `VERSION`、`package.json`、`package-lock.json`、`assets/usage-constants.js` 中的版本和 CHANGELOG，再运行打包脚本。相同版本不会触发已有安装的自动升级；应使用更大的版本号。

## 可选：用 Git 命令上传并触发自动发布

先创建空的公开 GitHub 仓库，再在导出的干净源码目录中运行：

```powershell
git init -b main
git add .
git commit -m "Publish v3.2.13"
git remote add origin https://github.com/leeanvien/Codex-Desktop-Usage-Monitor-Windows.git
git push -u origin main
git tag v3.2.13
git push origin v3.2.13
```

首次使用 Git 时可能需要设置自己的提交姓名、邮箱并在浏览器完成 GitHub 登录。无需把登录令牌或 API Key 写进文件。最后在 GitHub 的 **Actions** 中查看测试和发布结果。

GitHub 官方说明：[上传文件](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)、[管理 Release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)。
