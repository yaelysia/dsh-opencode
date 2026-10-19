# dsh-opencode

通过本地 [OpenCode 官方服务](https://opencode.ai/docs/server/) 接入 DSH 原生模型选择器。

**0.1.4 是实验版。** 文本桥接、错误传递与低流量诊断已经实现；不代表 OpenCode 云端免费模型一定接受当前网络的请求。尚未完成 DSH 工具调用双向映射或真正的逐 token 输出。

## 0.1.4：打开 DSH 后自动运行 OpenCode

默认启用自动管理。插件加载时首先检查 `http://127.0.0.1:4096/global/health`，已有健康服务会直接复用；否则在端口空闲时从独立安装位置启动 `opencode.exe serve`。启动不弹出额外窗口，无需用户先执行 `scripts/start.mjs`；插件卸载时仅结束它自己启动的进程。

自动启动仅支持 HTTP 127.0.0.1 入口。端口被其他进程占用但不是健康 OpenCode 时返回 `SERVER_PORT_BUSY`；未找到可执行文件时返回 `SERVER_NOT_INSTALLED`。启动期间不自动发送任何免费模型生成请求。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `autoStart` | `true` | 自动启动或复用本地服务 |
| `autoStartDirect` | `true` | 仅移除新进程的 HTTP(S)/ALL_PROXY 环境变量，不修改系统代理或 VPN/TUN |
| `opencodeExecutable` | 空（自动定位） | Windows 默认 `%LOCALAPPDATA%\Programs\OpenCodeCLI\opencode.exe` |
| `runtimeRoot` | 空（自动定位） | 默认 `%LOCALAPPDATA%\OpenCodeRuntime` |
| `autoStartTimeoutMs` | `15000` | 本地启动等待上限（毫秒） |

**更新插件后重启 DSH Desktop。** 如果你之前手动启动的服务仍在运行，新版会复用它。测试自动启动时，先在旧窗口按 Ctrl+C 停止旧服务，再重启 DSH。关闭 DSH 会结束插件启动的 OpenCode，但不会结束手动启动的服务。

## 清理失败的 npm 安装（不影响独立版 OpenCode）

先在 PowerShell 卸载残留 npm 包；再只清理指向 `opencode-ai` 的三个 shim 和旧包目录：

```powershell
npm uninstall -g opencode-ai

$npmBin = Join-Path $env:APPDATA 'npm'
$oldPackage = Join-Path $npmBin 'node_modules\opencode-ai'
foreach ($name in @('opencode', 'opencode.cmd', 'opencode.ps1')) {
    $shim = Join-Path $npmBin $name
    if ((Test-Path -LiteralPath $shim) -and
        (Select-String -LiteralPath $shim -SimpleMatch 'opencode-ai' -Quiet)) {
        Remove-Item -LiteralPath $shim -Force
    }
}
if (Test-Path -LiteralPath $oldPackage) {
    Remove-Item -LiteralPath $oldPackage -Recurse -Force
}
Get-Command opencode -All -ErrorAction SilentlyContinue
```

如果仍出现 `EPERM`，先关闭占用旧 npm 目录的程序，必要时重启电脑后重试。不要删除整个 `%APPDATA%\npm`、`%LOCALAPPDATA%\npm-cache`、`%LOCALAPPDATA%\Programs\OpenCodeCLI` 或 `%LOCALAPPDATA%\OpenCodeRuntime`。旧 shim 清理后，独立版 exe 和 DSH 自动启动不受影响。

## Windows：先做一次独立链路测试

已下载独立 `opencode.exe` 的情况下，不必再运行 npm 安装 OpenCode。下载本仓库后，在仓库目录执行：

```powershell
node .\scripts\start.mjs --probe
```

默认使用 `%LOCALAPPDATA%\Programs\OpenCodeCLI\opencode.exe`、端口 `4096`。如果旧的 `opencode serve` 仍在运行，先在它的窗口按 Ctrl+C；脚本不会杀掉占用端口的进程，也不会悄悄换端口。

若要按 OpenCode 错误提示排除 **代理环境变量** 的影响，执行：

```powershell
node .\scripts\start.mjs --direct --probe
```

`--direct` 仅清除新启动 OpenCode 进程继承的 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY，保留其他程序的代理和系统设置。NO_PROXY 补上本地回环地址。**它不会关闭系统 VPN/TUN、改变公网 IP 或解除服务端封禁。** 网络策略要求使用代理时不要加此选项。

脚本还会：

- 为未设置的 XDG 目录使用 `%LOCALAPPDATA%\OpenCodeRuntime` 下的对应目录，避免默认 `.cache` 的权限问题；已有 XDG 配置不覆盖。
- 在独立空工作目录启动官方服务，查询健康版本、真实模型目录及 agent，不输出密钥。
- `--probe` 仅发送一条固定测试消息，默认指定 `deepseek-v4.1-flash-free`；不扫描所有模型、不自动重试、不自动换模型或付费。OpenCode 内部的执行步数由官方服务决定。
- 写入 `OpenCodeRuntime/opencode-diagnostic-<时间戳>.json`。测试成功时保持服务运行供 DSH 使用；失败时停止本次脚本启动的子进程。

已有服务不需重启时，只诊断它：

```powershell
node .\scripts\doctor.mjs --probe --out .\opencode-diagnostic.json
# 不带 --probe：只检查本地健康、模型与 agent，不发送生成请求。
node .\scripts\doctor.mjs
# 明确指定另一个测试模型；不会自动切换。
node .\scripts\doctor.mjs --probe --model glm-5.3-flash-free
```

启动器接受 `--exe "C:\实际路径\opencode.exe"`、`--root`、`--port` 和 `--model`；诊断器接受 `--endpoint`、`--agent`、`--model`、`--out`。不改变现有 OpenCode 账户或全局配置。

## 安装 DSH 插件

已确认独立 OpenCode 可以生成文本后，直接安装/更新插件；0.1.4 无需提前手动启动服务。

**DSH 0.2.1-rc.2 Desktop：** 在桌面应用自己的「插件」页使用下面的 Git 来源安装/更新，确认安装版本为 `0.1.4` 后重启 DSH。Desktop 拥有自己的 profile，不要假定 CLI 的 `--profile desktop` 一定对应正在使用的桌面实例。

```text
git+https://github.com/yaelysia/dsh-opencode.git#feat/native-opencode-provider
```

已确认 CLI profile 的用户可以使用 `dsh plugin --profile <实际 profile 名> add <安装来源>`。为固定安装内容，将上述分支名换成经过核对的完整提交 SHA。

标题修复不需要重新下载、重装或重启已经工作的 OpenCode 服务；保留其服务窗口。

模型选择器中的提供商为 `OpenCode (official serve)`，默认包含 `deepseek-v4.1-flash-free` 和 `glm-5.3-flash-free`。这份插件目录是可配置的模型 ID 列表，不是实时可用性保证；诊断器会另外核对 OpenCode 服务的真实目录。

| 配置 | 默认值 | 说明 |
|---|---|---|
| endpoint | http://127.0.0.1:4096 | 官方本地服务 |
| providerId / backendProviderId | opencode-serve / opencode | DSH / OpenCode 路由 |
| agent | plan | OpenCode 内部 agent |
| models | 两个默认免费模型 | 可选模型 ID |
| localTitles | true | DSH 标记为 session-title 的请求使用本地短标题，不调用云端 |
| timeoutMs | 120000 | 单个本地 HTTP 请求期限 |
| username / passwordEnv | opencode / OPENCODE_SERVER_PASSWORD | 本地服务 Basic Auth；密码仅从环境读取 |

## 0.1.3：修复会话标题

0.1.2 的本地标题逻辑错误地截取了标题请求的外层指令，导致侧栏出现 `Generate the session title from...`。DSH 0.2.1-rc.2 实际把人类消息包装成如下输入：

```text
Generate the session title from this JSON array of human messages:
[{"seq":7,"text":"只回复数字1，不使用工具。"}]
```

现在仅在 `purpose: session-title` 的本地分支中解析这个 JSON，读取真实的 `text`，示例标题为 `只回复数字1，不使用工具。`。也支持更新标题时的 `{ currentTitle, messages }` 格式；已有正常标题保持不变，旧版指令标题会在宿主下次请求更新时重新从人类消息提取。畸形/未知框架返回 `INVALID_TITLE_INPUT`，不把框架指令写成标题。

`localTitles: true` 仍然表示**本地首条有效人类消息的短摘录**（最多 40 个 Unicode 码点），不是模型语义总结，不额外调用免费模型。普通聊天、网络路径和模型选择不变。

**安装更新不会批量改写已保存的标题。** 默认首条消息标题策略可能不会重新生成旧会话标题；新会话使用修复逻辑，旧会话可在 DSH 中手动重命名。

## 请求保护与错误处理

标题辅助请求不再额外请求模型；主请求串行派发，避免并发创建会话。不同模型/用途的会话隔离，改写历史及失败后不再复用旧游标。系统指令传入官方 `system` 字段。

`HTTP 200 + info.error`、空回答及非 2xx 都明确报告失败。网络/客户端拒绝后在插件实例中冷却 60 秒，期间继续返回原失败而不重复发送；**这是减少重复请求，不是等待官方 60 秒后解封**。到期只允许用户新发起的请求，不安排后台自动重试。取消/超时会尽力终止对应 OpenCode 会话。

| 错误码 | 区分 |
|---|---|
| NETWORK_BLOCKED | 网关明确报告当前网络/IP 的 abusive traffic 限制 |
| CLIENT_RESTRICTED | 网关明确要求从 OpenCode 内使用 |
| REGION_RESTRICTED | 明确的地区限制 |
| FORBIDDEN | 其他或未能细分的 403，不猜原因 |
| AUTH / RATE_LIMIT | 凭据错误 / 限流 |
| UPGRADE_REQUIRED | 服务明确要求升级 |
| MODEL_NOT_FOUND / MODEL_MISMATCH | 服务目录缺少模型 / 返回了不同模型 |
| EMPTY_RESPONSE / TIMEOUT | 无可见文本 / 本地请求超时 |
| INVALID_TITLE_INPUT | 本地标题请求框架损坏或不支持，不输出指令标题 |

错误和诊断保留必要状态，不输出完整 provider/config 数据、认证头或提示词。Wire Trace 只反映 DSH 到本地 OpenCode 的 HTTP 链路，HTTP 200 不等于云端推理成功。

## 验证边界

`npm test` 使用 Node 原生测试框架，覆盖模拟响应及真实 localhost HTTP 链路。它们不是云端模型测试。Windows 启动与用户出口的实际推理仍需用上述脚本验证；程序不能从别的电脑判断用户当前公网出口是否解除限制。

当前桥接只输出文本，OpenCode 返回完整消息后才转换成 DSH 分片。OpenCode 内部工具由其自身权限系统管理，不会自动受 DSH 的工具审批覆盖。

## 参考

- [OpenCode Network：代理环境变量与本地 NO_PROXY](https://opencode.ai/docs/network/)
- [OpenCode Server：健康检查、模型目录、会话消息 API](https://opencode.ai/docs/server/)
- [IP 限制报告 #56853](https://github.com/anomalyco/opencode/issues/56853)：官方机器人回复建议联系 `help@anoma.ly`；没有可据此保证的自动解封期限。
- [DSH 0.2.1-rc.2 标题请求包装](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/session/session-title-first-prompt-llm/src/index.ts)
- [DSH 0.2.1-rc.2 多轮标题更新](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/experimental/session-title-all-prompts-llm/src/index.ts)
- [DSH Bundle 发布规范](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/develop/basic/publish.md)

MIT License。
