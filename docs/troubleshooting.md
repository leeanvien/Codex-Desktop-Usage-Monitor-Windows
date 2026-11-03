# 故障排查指南

本文档提供 Codex Usage Monitor 的日志位置、动态端口检查和常见恢复步骤。优先采用只读检查，不要直接修改 WindowsApps、`app.asar`、Codex 登录文件或模型配置。

## 1. 点击快捷方式没有反应

1. 正常退出已经打开的 Codex。
2. 检查 Node.js：

   ```powershell
   node -v
   ```

3. 确认版本为 22 或更高。
4. 从当前版本目录重新运行安装器：

   ```powershell
   pwsh -NoProfile -File .\install.ps1
   ```

隐藏启动器会把脚本缺失、启动异常或非零退出码写入：

```text
%LOCALAPPDATA%\CodexUsageMonitor\launcher-error.log
```

## 2. Codex 启动但没有监视栏

必须从桌面的 `Codex Usage Monitor` 快捷方式启动。原生 Codex 图标不会开放 CDP 端口。

启动器识别到携带 CDP 参数的 Codex 后，会启动可复用的隐藏等待助手；对应 Codex 仍在运行时持续等待，不再因超过 180 秒而放弃。端口可访问、已有应用页面和监视栏心跳正常是不同阶段。读取实际动态端口：

```powershell
$state = Get-Content -Raw -LiteralPath "$env:LOCALAPPDATA\CodexUsageMonitor\state.json" | ConvertFrom-Json
$state.port
```

检查 CDP 是否可连接：

```powershell
Invoke-RestMethod "http://127.0.0.1:$($state.port)/json/list"
```

首选端口被占用时，启动器会自动选择后续可用端口，因此不要硬编码历史端口。

等待助手的阶段记录在 `%LOCALAPPDATA%\CodexUsageMonitor\readiness-wait.log`，包含 `waiting`、`ready`、`exited` 或启动失败分类以及对应 Codex PID/端口。日志有大小限制，不含凭据。后台尚未接入时，`state.json` 可能仍是上一次运行的记录，应结合进程和等待日志判断。

`state.json` 中的 `startupPhase` 为 `waiting-ui` 时表示后台仍在等待页面连接，`ready` 表示已验证指定后台进程的心跳；这不代表每个数据源的网络请求都已成功。启动验证只读，不会重新注入面板。CDP 仍可访问但尚无可用页面时，后台继续等待；CDP 连续不可访问 180 秒后才退出，避免关闭 Codex 后残留后台。

如果出现 Codex 原生“无法加载组织设置”，请先处理原生窗口中的网络连接或重试。该原生启动阶段发生在监视器注入前，等待助手不会绕过组织策略、改写登录状态或强制重启 Codex；原生页面恢复后自动连接监视器。原生设置请求失败也可能暂时影响界面语言和工作区加载。额度显示 `--` 时，应查看展开面板中的官方数据源错误，不能把 `--` 当成设置被删除。

如果监视栏显示“监视器已断连”，展开面板会保留旧数据并标注连接中断。已有 CDP 端口时，双击桌面专用快捷方式即可重新连接，无需关闭 Codex；仅有残留面板不能证明后台还在运行。后台真正退出时，启动诊断会记录进程和退出信息，不再被空日志的空值错误覆盖。

3.2.7 起，心跳独立于页面连接和会话读取；单个页面冻结不会阻塞其他窗口。心跳请求 5 秒无响应会关闭失效会话并重新连接，即使旧 WebSocket 仍标记为 OPEN。此功能不能阻止 Windows 内存耗尽或 Codex 自身崩溃；若反复断连，应同时检查 Windows 的 Application Error 和 Resource-Exhaustion-Detector 事件。代理退出会使在线额度查询失败，单独的代理断开不应被当作本机心跳断开。

## 3. Codex 更新后监视栏消失或位置异常

Codex 更新可能改变 Composer DOM。先检查：

- `%LOCALAPPDATA%\CodexUsageMonitor\state.json` 中的 `runtimeVersion`、`port` 和 `injectorPid`。
- `injectorPid` 对应进程是否仍在运行。
- CDP `/json/list` 是否仍能看到 Codex 页面。
- 监视器日志是否出现 `insufficient-composer-width`、`composer-not-found` 或注入异常。

只替换监视器后台、不重启 Codex：

```powershell
pwsh -NoProfile -File .\scripts\start-monitor.ps1 -Port <实际端口> -Replace
```

不要反复重装或强制关闭当前 Codex；先确认是启动失败、端口变化还是页面布局不兼容。

## 4. 官方订阅指示灯反复变红

红色表示已有数据因本次官方请求失败而暂时过期，不代表额度耗尽。可能原因包括：

- 本机 app-server 暂时未响应。
- 独立 Codex CLI 与桌面捆绑 CLI 版本不兼容。
- Microsoft Store 更新后运行时副本需要刷新。
- 网络或本机代理临时异常。

监视器会优先使用用户安装的兼容 CLI；用户设置的 `CODEX_USAGE_CODEX_PATH` 具有最高优先级。Microsoft Store CLI 无法由 Node 直接从 WindowsApps 启动时，会复制到 `%LOCALAPPDATA%\CodexUsageMonitor\runtime\codex-cli` 后运行。

## 5. API Key 重启后失败

检查下列文件是否存在，不要输出文件内容：

```text
%LOCALAPPDATA%\CodexUsageMonitor\provider.json
%LOCALAPPDATA%\CodexUsageMonitor\api-key.dpapi
```

DPAPI 凭据只能由保存时的 Windows 用户在同一台电脑上解密。换用户、换电脑或删除本地状态后需要重新配置。

如果显示“请求受限”，说明用量接口返回 `HTTP 429`，不等于 Key 失效。等待 60、120、240 或 300 秒自动重试，避免反复重启、手动刷新或重复保存配置。

## 6. API 账户请求失败

确认：

- 用户 ID 是数字。
- Base URL 与服务商公开文档一致。
- 访问令牌是完整单行文本。
- 账户接口返回 JSON。
- 远程接口使用 HTTPS。

不要把真实令牌、完整私有响应或用户 ID 发到聊天或提交到仓库。需要适配字段时，只提供公开文档或脱敏后的响应结构。

## 7. 设置没有记住

显示项和六个界面开关保存在：

```text
%USERPROFILE%\.codex-usage-monitor\ui-settings.json
```

这个文件统一保存显示项、顺序、保活和每个对话的续跑设置，浏览器 localStorage 仅作为缓存。首次缺少新文件时会迁移旧 `%LOCALAPPDATA%\CodexUsageMonitor\ui-settings.json`；新文件已有有效设置时不会被旧文件覆盖。请检查是否设置了自定义 `CODEX_USAGE_UI_SETTINGS_PATH`。

文件只包含白名单设置，不包含账号凭据。损坏的权威文件会保留并明确报错；应修复文件或恢复备份，程序不会静默用默认值覆盖。

## 8. 额度恢复后没有自动续跑

确认原任务展开面板中的“额度恢复续跑”已开启，并检查：

- 原任务是否明确以官方 `usage_limit_exceeded` 结束。
- 错误给出的重置时间是否已经到达，官方订阅对应周期是否重新大于 `0%`。
- 原任务是否已经停止运行；监视器会按任务 ID 发送，无需停留在原任务页面。可见输入框内容不会阻止内部续跑请求。
- 是否已经手动发送了新消息；手动开始新一轮会取消旧的自动等待。
- “续跑发送内容”是否为非空单行文本；留空或填写无效内容时会恢复默认值“继续”。

等待状态保存在 `%LOCALAPPDATA%\CodexUsageMonitor\auto-resume-state.json`，只含事件 ID、会话 ID、重置时间和防重复状态，不含发送内容、对话正文或凭据。自定义发送内容保存在 `ui-settings.json`，请勿填写密码或令牌。自动发送通过 Codex Desktop 内部请求客户端完成，不读取或覆盖可见输入框；失败时会保留等待状态并稍后重试。

若额度已恢复但显示 `desktop-request-client-unavailable`，说明监视器未能取得桌面内部发送客户端，监视栏仍可正常显示额度。3.2.8 起通过现有本机主机注册表读取作用域内的管理器，并优先检查 React 状态，兼容客户端不再出现在可枚举对象树的情况。升级并替换监视器后台即可继续核对已保存的等待记录，无需重启 Codex 或重新开关续跑；若任务已手动继续，则不会补发旧事件。

## 9. 安全软件拦截

项目没有编译 EXE、自启动服务或下载器，但隐藏 PowerShell、Node 后台进程和 CDP 参数可能触发启发式检测。添加相关行为放行，或直接关闭杀毒软件。

检查安全软件隔离记录后，重新运行 `install.ps1` 并验证桌面快捷方式。

## 10. 完整测试

在源码目录运行：

```powershell
npm ci
pwsh -NoProfile -File .\tests\run-tests.ps1
```

测试包括协议解析、UI 生命周期、设置持久化、额度恢复状态机、Codex Desktop 输入发送保护、DPAPI、配置校验、启动器、安全扫描和发布包白名单。如果完整测试通过但实时界面异常，应继续检查动态 CDP 端口和当前 Codex DOM。
