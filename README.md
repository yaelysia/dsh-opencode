# dsh-opencode

将 OpenCode 官方 `serve` 模型接入 DeepSeek Harness（DSH）。模型推理经过 OpenCode，真实工作区工具的审批和执行仍属于 DSH。

**当前：0.2.0-alpha.18，实验版本，PR #1 尚未合并。** 新增原生 `dsh_call` 结构化通道，旧通道默认保留。官方 OpenCode 1.19.3 + 本地模拟模型已能验证完整工具交接；真实免费模型网关和 DSH Desktop 审批界面仍需实测。本项目与 OpenCode 官方无隶属关系，不提供绕过免费模型限制的机制。

## 安装与使用：只需操作 DSH

环境要求：DSH 0.2.x（对照 0.2.1-rc.2 Desktop）及 Node.js >=22.19.0。**无需独立安装 OpenCode CLI**：本插件固定依赖官方 `opencode-ai@1.19.3`，安装时由 DSH 包管理器一并获取对应的平台二进制。运行时不会自行下载或升级。

在 DSH 插件页以 Git 来源安装：

```text
git+https://github.com/yaelysia/dsh-opencode.git#feat/native-opencode-provider
```

复现某个版本时，将分支名换成完整提交 SHA。更新后完整退出并重启 DSH Desktop。

进入 **插件 → 已安装插件 → dsh-opencode**，配置表单直接显示在详情页。开启 **「结构化工具通道（实验）」**，保存并重启后即可使用新通道；需要实时预览时同时打开「SSE 流式输出预览」。默认模型列表提供 `deepseek-v4.1-flash-free`、`glm-5.3-flash-free`，是否可用仍取决于 OpenCode 网关、账户与网络。

**不需要**另外安装 OpenCode CLI/插件、修改 OpenCode 配置文件、手动运行启动命令或清理 YAML。DSH 插件自动完成固定版本 CLI 解析、后台插件装载、回环通信端口分配、随机认证、隔离 Agent 配置和子进程管理。退出/卸载会释放等待的工具回调并停止自身进程，不终止未知外部进程。

如果旧的手动服务仍占用 `127.0.0.1:4096`，插件不会擅自接管它；关闭那一个已知旧服务后再让 DSH 自动启动。默认直接使用插件依赖中的固定版本 CLI，不依赖 `%LOCALAPPDATA%\Programs\OpenCodeCLI`、OpenCode Desktop 或 PATH。仅当配置 `opencodeExecutable` 或 `OPENCODE_EXECUTABLE` 时，才使用外部 CLI（版本兼容性由用户自行维护）。

## 内置固定版本 OpenCode CLI

`opencode-ai@1.19.3` 作为普通运行依赖，其官方可选依赖提供各平台原生二进制。插件直接解析二进制，不依赖全局 npm shim、手工硬链接或安装后脚本；x64 优先使用 baseline 变体以兼容不支持 AVX2 的 CPU。

安装或更新插件时需要包管理器能获取 npm 依赖，首次安装会增加 CLI 下载体积。插件运行时不会自动下载或升级。若 CLI 可选依赖缺失或版本不一致，将明确报错，不会偷偷使用全局 OpenCode 或 Desktop 内置版本。已安装的旧插件请更新/重装后完整退出并重启 DSH。

**Windows 安装目录提醒：** 曾有 DSH 安装目录的文件 ACL 与 Windows 低完整性沙箱冲突，造成 PTC Worker 和 `pwsh` 权限异常。该案例通过将 DSH 安装到非原默认目录得到解决，与 `dsh_call` 无关。遇到类似 `EPERM` 请先检查安装目录权限，不要递归重置系统目录 ACL，也不要长期关闭沙箱。

## 新通道如何交接工具

```text
DSH 当前工具目录与指令
  → 本机 OpenCode 的原生 dsh_call(name, arguments)
  → 仅本机可访问的认证通信端口（不执行文件或命令）
  → DSH tool-call + finish(tool-calls)，立即交还控制权
  → DSH 审批、实际执行或拒绝
  → 下一步返回对应 callId 的真实结果
  → 释放同一个 OpenCode 请求，继续模型推理
```

与旧通道不同，结构化模式不要求模型输出 `DSH_TOOL_CALL_V1` 文本，不修补文本 JSON，也不从失败的原生工具事件反推动作。模型调用已注册的 `dsh_call`；工具名称必须在当前 DSH 白名单中，详细参数和执行权限仍由 DSH 校验。

OpenCode 的工具回调等待 DSH 结果时，适配器先结束当前 DSH 模型步骤，而不是等待整个 OpenCode HTTP 请求完成。因此两端不会因互相等待结果而停住。下一次 DSH 调用把实际执行结果或拒绝信息送回同一个等待中的请求，**不重发初始模型请求、不假造工具成功**。

结构化模式自动启用托管服务和工具隔离，旧 read 兼容、外部服务、自动启动开关不控制这个模式；原有配置值不会被改写，关闭新模式后可以回到旧通道。任何新通道错误都不会触发隐式回退或放宽原生工具权限。

`read` 与需审批的 `bash` 声明仅为已观察到的免费模型兼容性保留；后台插件在实际执行前**拒绝除 `dsh_call` 以外的所有原生工具**，包括 `bash`。这种声明不赋予 OpenCode Shell 权限，实际执行仍由 DSH 控制。OpenCode 的运行目录不是 DSH 工作区，文件工具由 DSH 按会话工作区解析路径。

## 工具结果之后的上游失败与重试安全

如果 DSH 已经执行或拒绝了一次工具请求，OpenCode 在接收工具结果后继续生成时可能返回 `429 / Endpoint is unavailable`。这属于上游模型续接失败，不代表刚才的 DSH 工具没有成功执行。

**已经交付过 DSH 工具调用的 OpenCode HTTP 请求一旦终止，就不能当作普通限流重发。** 新版以 `TOOL_CONTINUATION_FAILED` 保留原始失败原因和 HTTP 状态，并阻止 DSH 自动重试已消费的工具结果；同一工具结果重复提交时仍返回同一原始错误，不会偷偷再次执行工具。新的用户消息可以重新开始会话。工具交付前发生的 `RATE_LIMIT` 则仍交由 DSH 原有重试策略处理。

这里解决的是**失败分类与重复执行风险**，并不代表 OpenCode 免费模型网关的 429 / `Endpoint is unavailable` 已修复。若同一模型持续在工具续接时被拒绝，需要单独验证服务端的工具连续调用兼容性。

## 工具入口提示词与 DSH PTC 模式

结构化模式自带 OpenCode `dsh-bridge` Agent 默认指令，明确要求模型在需要工作区操作且 DSH 提供相应能力时，**只调用已注册的 `dsh_call`**。OpenCode 原生 `read/glob/edit/shell` 等工具可能因为免费模型兼容性仍可见，但绝不允许执行；不应该先尝试这些工具，也不能把文本协议 `DSH_TOOL_CALL_V1` 当作新通道调用方式。

插件还会根据**当前这一轮 DSH 真正声明的工具目录**自动注入用法，用户不需要另外维护提示词。alpha.16 避免将 DSH 系统指令及 PTC SDK 重复注入，并将提示词合并为单条 System 消息，以改善 OpenAI-compatible 模型网关的兼容性：

- **标准模式（Native）：** `dsh_call({name: "glob", arguments: {pattern: "*.txt"}})` 等，由 DSH 处理实际工具权限、路径和执行结果。
- **PTC 模式：** DSH 对模型只公布 `run_code`，因此调用 `dsh_call({name: "run_code", arguments: {code: "...", description: "..."}})`。程序内部再用 DSH 自动生成的 `tools.*` SDK 调用文件/检索等工具。PTC 的运行环境、沙箱与嵌套授权仍由 DSH 控制，不会移到 OpenCode。
- 没有可用的 DSH 工具，或者任务本身不需要工具时，正常生成文本即可，不强制发起空工具调用。

**PTC 更适合**批量读取、聚合统计、条件判断与多步骤流程，可以减少模型每一步往返；单个文件读写通常仍建议标准模式，减少生成程序的成本。选择标准/PTC 仍通过 **DSH 自己的任务模式**，插件自动识别，不增加配置开关。提示词可提高首次正确选择概率，但不能代替安全守卫，也不能保证模型完全不再尝试原生工具。

## 配置与恢复默认

表单支持保存、单项恢复默认和恢复全部默认值；由 DSH 原生配置服务持久化。不需要用户创建或维护独立覆盖文件。**保存后完整重启 DSH**：安全边界、模型注册和服务进程按启动时的配置快照创建，不在生成中途热切换。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `structuredToolsEnabled` | `false` | 新结构化通道；开启后后台插件、端口及进程自动管理 |
| `toolBridgeEnabled` | `true` | 允许向 DSH 交付工具请求；关闭后带工具的请求明确拒绝 |
| `ssePreviewEnabled` | `false` | 事件流预览；结构化通道的工具交接不依赖 SSE |
| `localTitles` | `true` | 从用户文本生成标题，不额外请求模型 |
| `guardedReadCompatibility` | `false` | 仅旧通道的 read 兼容实验；新通道自动处理 |
| `strictOwnedServer` | `true` | 旧通道默认拒绝外部服务；新通道始终要求托管 |
| `autoStart` | `true` | 旧通道的自动启动开关；新通道始终自动启动 |
| `autoStartDirect` | `true` | 仅为子进程清除 HTTP(S)/ALL_PROXY，不修改系统 VPN/TUN |
| `endpoint` | `http://127.0.0.1:4096` | 模型服务地址；托管模式要求本机回环 HTTP |
| `opencodeExecutable` / `runtimeRoot` | 自动 | 默认使用插件固定依赖的 1.19.3 CLI；填入外部 CLI 路径则覆盖 / 独立运行目录 |
| `timeoutMs` / `autoStartTimeoutMs` | `120000` / `15000` | 模型生成 / 服务启动超时，单位毫秒 |
| `username` / `passwordEnv` | `opencode` / `OPENCODE_SERVER_PASSWORD` | 认证设置；托管服务始终生成随机密码 |
| `models` | 两个默认模型 ID | 可编辑列表；列表出现不代表网关已授权使用 |

## 范围与限制

结构化模式最多保留 16 个活跃 OpenCode 周期，每个周期最多接收 128 个不同的工具请求。等待 DSH 审批/工具结果最多 10 分钟，期间暂停普通模型超时；取消、超时或卸载会关闭回调。应用重启后不会恢复或重放未完成工具操作。

若上游明确提供 `reasoning` 类型，结构化模式会将其映射到 DSH 思考块，`text` 保持正文；不能根据内容是英文还是中文推断边界。上游若将推理混进普通文本，本版本不会启发式剥离。

复杂多模态工具结果、跨应用重启续接以及完整用量归集不在本轮验证范围。当前工具参数的完整 Schema 校验仍在 DSH 宿主，结构化回调负责名称白名单、调用身份与传输约束，不代替宿主授权。

旧通道仍保留文本协议和已验证守卫拒绝的工具意图转换，便于对照与回退；它的已知兼容性问题没有因为新通道发布就被宣称解决。

## 常见错误

| 错误 | 含义 |
| --- | --- |
| `SERVER_PORT_BUSY` / `UNTRUSTED_OPENCODE_SERVER` | 端口由其他服务占用，不能接管 |
| `SERVER_BUNDLED_CLI_MISSING` / `SERVER_BUNDLED_CLI_INVALID` | 官方 CLI 包未正确安装或版本不一致；更新/重装插件并保留可选依赖 |
| `SERVER_BUNDLED_CLI_UNSUPPORTED` | 当前系统或 CPU 架构没有受支持的官方 CLI 包 |
| `SERVER_NOT_INSTALLED` | 显式指定的外部 CLI 文件不存在；检查 `opencodeExecutable` |
| `SERVER_GUARD_NOT_READY` | 后台插件未完成启动证明，拒绝继续模型请求 |
| `CLIENT_RESTRICTED` / `NETWORK_BLOCKED` / `RATE_LIMIT` | 上游网关拒绝或限流。部分官方 OpenCode 客户端也会因 `read/bash` 工具不在请求目录、账号或网络条件触发 `CLIENT_RESTRICTED`；alpha.17 仅修正本插件的受限 Agent 工具声明，不保证所有免费账户/网络可用，也不会绕过服务端拒绝 |
| `TOOL_RESULT_REQUIRED` / `TOOL_RESULT_MISMATCH` | DSH 返回结果与当前等待的调用 ID 不符，不能重放 |
| `TOOL_CONTINUATION_FAILED` | DSH 已收到工具调用后 OpenCode 模型续接失败；保留真实上游错误与状态，不允许重复提交已完成工具结果 |
| `TOOL_RESULT_TIMEOUT` | 等待审批或工具结果过久，已结束等待 |
| `CONCURRENT_STREAM` | 同一 DSH 会话出现重叠模型消费者 |
| `OPENCODE_TOOL_BOUNDARY` | 发现不允许的原生执行迹象，停止而非降级执行 |

独立诊断脚本 `scripts/start.mjs --probe` / `--stream-probe` 仍面向开发排障，**正常安装和使用不需要运行**。这些显式探针会发起一次指定免费模型请求；普通启动不会自动探测云端模型。

## 自动化测试

```bash
npm test
npm pack --dry-run --ignore-scripts
# 开发验证，需要提前准备官方 CLI：
OPENCODE_TEST_EXE=/path/to/opencode npm run test:structured
```

结构化集成测试使用官方 OpenCode 1.19.3 和本地模拟模型，在 DSH 侧以测试程序模拟授权/执行，覆盖 `glob → read → edit`、拒绝编辑、取消等待和双会话隔离。CI 在 Windows/Linux 下安装已发布的 DSH 0.2.1-rc.2 包，以真实 `BlockAssembler` 和工具结果类型进一步核对协议。**这些通过不等于真实免费模型网关与 Desktop 审批界面已通过。**

开发检查点：`docs/STRUCTURED_TOOL_HANDOFF.md`。

参考：[OpenCode](https://github.com/anomalyco/opencode)、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。MIT License。
