# dsh-opencode

通过 **OpenCode 官方 `serve` API**，把 OpenCode 模型接入 **DeepSeek Harness（DSH）** 原生模型选择器；由 DSH 执行和审批工具，OpenCode 仅负责模型推理。

**当前版本：`0.2.0-alpha.9`（原生守卫证明与中文工作区指令修复）。** 默认使用此前的同步 `/message` 路径；SSE 预览不再默认打开，避免未经真实环境验收的增量机制影响普通会话。 基本模型对话和模拟工具闭环已覆盖自动化测试，**真实 DSH Desktop + 云端模型的工具授权闭环尚未验收**。OpenCode 免费模型可能因账户、地区、网络或服务端策略而不可用，本项目不提供绕过机制。

## 工作原理

```text
DSH Agent
  └─ GenerateOptions（系统提示 / 历史消息 / DSH 工具定义）
       └─ dsh-opencode（LlmAdapter）
            └─ 本机 OpenCode serve（隔离的 dsh-bridge Agent）
                 └─ OpenCode 模型推理
                      ├─ 普通文本 → DSH 回复
                      └─ DSH_TOOL_CALL_V1 → DSH tool-call
                                             └─ DSH 授权 / 执行 / 拒绝
                                                  └─ 工具结果进入下一轮模型请求
```

**OpenCode 原生工具不具备执行权限。** 托管子进程采用 `permission: { "*": "deny" }`，隔离项目配置、插件、MCP 和其他 Agent。工具请求只转换为 DSH 的 `tool-call` 流块，代码本身不执行工具。

### 已实现

- 官方 `/session` 和 `/session/:id/message` 接口适配；模型与会话路由、错误传播、取消和超时处理。
- **可选 SSE 增量输出（默认关闭）**：仅显式开启 `ssePreviewEnabled` 后，才会在同步 `/message` 请求期间订阅 `/event` SSE 并发送 DSH `text-delta`；最终响应负责校验与补齐。
- DSH 工具定义转为模型可读 JSON Schema；文本协议解析、白名单校验、工具结果及 `callId` 回传。
- **DSH 指令与工作区优先级**：DSH `system` 和 `developer` 消息一并放入 OpenCode 模型请求的 system slot，不再把 developer 规则降级为普通用户文本。在提供文件读写、搜索工具时明确优先使用 DSH `read/write/edit/glob/grep`，而非 `pwsh/bash`。OpenCode 的隔离子进程工作目录不是 DSH 工作区；由 DSH 专用工具决定相对文件路径，受守卫拦截的原生 shell `workdir` 不会跨边界传给 DSH。\n- **被拦截工具证明**：受保护兼容模式的 OpenCode 子进程会在 `tool.execute.before` 拒绝原生工具前，追加只含随机启动证明、Session ID、调用 ID 和工具名的本地审计记录。即使 OpenCode 将异常包装成通用错误，桥接也仅在核实该拒绝记录、工具最终状态为 `error` 且不存在执行证据后，才能将其转交 DSH；没有证明仍拒绝。审计不存储工具参数或文件内容，退出时清理。
- **中文规则**：DSH 的 `agent-instructions` 工作区消息（如 `AGENTS.md`）明确进入上游 system 输入中的低于 system/developer 的用户指令段，不再仅淹没在扁平化的历史文本内。
- **SSE 工具终态回查**：SSE 先发 `pending/running`，不代表工具已执行，也不代表最终失败；OpenCode 的 `/message` 还可能只返回最终 assistant 步骤，遗漏前面经守卫拒绝的工具。遇到无法从最终响应确认的工具事件时，桥接器使用官方只读 `GET /session/:id/message?limit=80` 查询终态，按工具 part ID 与 assistant message ID 验证，最多有限重查两次。仅在最终状态明确为本地守卫拒绝时才转成 DSH tool-call；缺失、未完成或已执行迹象仍拒绝。
- **拦截后转交 DSH**：兼容模式下，带有安全守卫明确拒绝标记的 OpenCode 原生 `read/write/edit/glob/grep/shell` 意图，可映射至本轮 DSH 已声明的同类工具和 JSON Schema，参数显式重命名。只有 DSH 可以审批或执行；没有匹配工具、事件不可信或 provider 侧已经执行仍报错；一次生成多个被拦截请求时，只把第一个交给 DSH，余下的等待下一轮模型决定。
- **SSE 最终纠正**：`/event` 增量是预览，完整 `/message` 响应才是最终文本。当两者不一致时由 DSH `block-end` 纠正内容，不会在成功生成后抛出 `STREAM_MISMATCH`。诊断只记录字符数，不记录正文。
- 自动启动与释放插件拥有的 OpenCode 子进程；不终止未托管进程。
- 仅支持隔离的 `dsh-bridge` Agent；`plan`、`build` 和自定义 Agent 均报 `BRIDGE_AGENT_REQUIRED`，防止绕过权限边界。
- **可选受保护的 read 兼容性实验**：对照 0.1.5 的 `read: allow` 声明，保持其他原生工具禁用；额外注册仅属于托管 OpenCode 子进程的 `tool.execute.before` 拦截插件。插件拒绝每次 OpenCode 原生工具执行，并在启动时写入一次性随机证明；证明校验失败，则拒绝模型调用。该模式未在真实 OpenCode 免费模型联测验证，默认禁用。
- 本机随机 Basic Auth、独立运行目录、代理环境变量的子进程级处理。
- `session-title` 请求本地提取首条有效用户消息（不额外调用云模型）。

### 目前限制

- 工具调用仍使用**实验性单条文本协议** `DSH_TOOL_CALL_V1:{"name":"...","arguments":{...}}`，或在受保护模式下处理一次经守卫拒绝的原生工具意图，并非完整原生 Function Calling。一次模型响应只能交付一个 DSH 工具请求；多个被拦截的原生请求按顺序只选第一个，绝不批量执行。
- **流式输出依赖 OpenCode SSE 实际提供文本事件。** 如果 OpenCode 只发送心跳、事件接口失效或丢失增量，插件会等待 `/message` 的最终回复，不伪造逐 token 输出。OpenCode 1.18.x 曾出现 SSE 丢事件问题，1.19.3 的真实 Desktop 表现仍需验收。
- 工具协议 JSON 前缀和后续参数会被缓冲；受守卫拒绝的原生工具意图也须完整验证、匹配当轮 DSH schema。只有检查通过才向 DSH 发送 `tool-call`，绝不把半截 JSON 当成已批准操作。
- OpenCode `serve` 消息接口不直接接收动态 DSH 工具函数定义；温度、停止序列、最大输出 token 等请求控制目前也没有完整的原生映射，不应依赖它们得到精确语义。
- 目前只声明文本输入模型；并不提供图像输入/生成能力。
- **工具选择偏好依旧依赖模型遵循提示词**：此版本会完整传递 DSH 的 system/developer 约束，但不能保证模型永不提出 `pwsh` 调用。若要技术上彻底禁止某类 shell 操作，需要在 DSH 宿主权限策略或工具层实施拒绝，而不应偷偷移除用户有权使用的工具。DSH `pwsh` 在未传 `workdir` 时会读取 DSH session working-directory；实际目录不正确时，应结合对应会话 `tool/call` 和 `tool/result` 定位，不应让 OpenCode 的隔离目录取代它。\n- 尚未通过真实 DSH Desktop 的授权 UI、允许/拒绝与连续工具调用验收。

## 环境要求

- DSH `0.2.x`（开发测试对照 `0.2.1-rc.2 Desktop`）。
- Node.js `>=22.19.0`，或由 DSH Desktop 提供符合要求的 Node 环境。
- 可运行的 OpenCode 官方 CLI；Windows 默认查找 `%LOCALAPPDATA%\Programs\OpenCodeCLI\opencode.exe`。其他平台默认从 `PATH` 查找 `opencode`。

## 安装与升级

在 DSH Desktop 的插件页面以 Git 来源安装当前 PR 分支：

```text
git+https://github.com/yaelysia/dsh-opencode.git#feat/native-opencode-provider
```

需要复现固定版本时，将分支名替换成 PR 最新的完整 commit SHA。**更新后完整退出并重新启动 DSH Desktop**。

如 `127.0.0.1:4096` 已被之前手工运行的 `opencode serve` 占用，先在其控制台按 `Ctrl+C` 停止，再启动 DSH。默认安全模式只允许插件启动并拥有的服务，不会接管或杀死未知进程。

首次验证建议使用两个默认模型之一：

- `deepseek-v4.1-flash-free`
- `glm-5.3-flash-free`

模型 ID 可以配置；出现在下拉列表中**不代表**当前网络和账户一定能成功调用。

### 配置页（不需要手动编辑 YAML）

DSH Desktop **侧边栏 → 插件 → 已安装插件 → dsh-opencode**。打开组合包详情后，配置表单直接显示在详情页面（高级配置默认折叠），无需再进入组件或编辑 YAML。

此页面由本插件自己的浏览器半侧提供（DSH 官方 `plugins.bundle.config` 扩展点），使用 DSH 的设置表单模型、提交与恢复默认功能。保存后，DSH 将配置持久化到它自己维护的 profile 配置中；不需要用户新建 `cordis.patch.yml` 条目，也不需要后续自行清理。曾通过 DSH 自己的配置机制保存的字段可在页面点「恢复默认」来撤销覆盖。

页面分为「模型与工具」「本地服务」「高级配置」：覆盖 `guardedReadCompatibility`、`ssePreviewEnabled`、工具桥接、本地标题、自动启动、代理处理、服务地址、运行目录、模型列表和超时等可配置项。普通模式保持 `guardedReadCompatibility=false` 和 `ssePreviewEnabled=false`，只有明确测试时才开启实验功能。

**保存后完整重启 DSH Desktop**：这套桥接将 OpenCode 子进程、安全守卫和模型注册绑定在插件启动时，因此修改页面中的值后，运行中的实例暂不热切换。关闭 DSH 前应停止当前模型生成，不要在有执行中任务时改动。

没有看到表单时：首先确认安装的是 `0.2.0-alpha.5` 及以上，且 `dsh-opencode` 组合包已启用；此版本直接附带预构建的 `lib/client.js`，无需另执行 npm 安装脚本或构建。

## 主要配置

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:4096` | 官方本地服务地址 |
| `providerId` / `backendProviderId` | `opencode-serve` / `opencode` | DSH 与 OpenCode 路由 |
| `agent` | `dsh-bridge` | **固定安全 Agent**，其他值拒绝 |
| `autoStart` | `true` | 启动插件时管理本地 OpenCode |
| `autoStartDirect` | `true` | 只为 OpenCode 子进程清除 HTTP(S)/ALL_PROXY 环境变量；不改变系统 VPN/TUN |
| `runtimeRoot` | 自动计算 | 独立工作目录与运行数据 |
| `strictOwnedServer` | `true` | 默认拒绝未托管服务；带 DSH 工具的请求总是要求托管服务 |
| `toolBridgeEnabled` | `true` | 文本工具协议；关闭后收到 DSH 工具会明确报错 |
| `guardedReadCompatibility` | `false` | 实验性 OpenCode 1.19.3 免费模型兼容性：对模型声明 `read: allow`，但由已加载的本地守卫拒绝所有原生工具执行；在插件配置页中开启 |
| `ssePreviewEnabled` | `false` | SSE 增量输出预览；仅手动设置 `true` 才会开启。旧版保存的 `streamingEnabled=true` 不再生效，避免自动启用未经验证的流式路径 |
| `localTitles` | `true` | 标题不调用云端模型 |
| `timeoutMs` | `120000` | 本机模型请求超时（毫秒） |
| `passwordEnv` | `OPENCODE_SERVER_PASSWORD` | 连接外部手动服务时的环境变量键；托管服务始终生成新的随机密码 |

自动启动的服务绑定 `127.0.0.1`，子进程使用规范变量 `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`。未认证请求收到 `401` 是预期行为。不会把密码写入 README、日志或诊断报告。

## 诊断

可以在 Windows 的仓库目录独立检查 OpenCode，而不启动 DSH：

```powershell
node .\scripts\start.mjs --probe
# 网络环境需要绕开 HTTP(S)/ALL_PROXY 时才加 --direct
node .\scripts\start.mjs --direct --probe
# 只运行一次免费模型请求，测量当前 OpenCode 是否真正发送增量 SSE
node .\scripts\start.mjs --stream-probe
```

该脚本在独立运行目录启动隔离服务、随机生成 Basic Auth 密码、进行健康与模型目录检查；`--probe` / `--stream-probe` 才会对明确指定的免费模型发送一次推理请求；后者要求实际收到 SSE 文本事件，否则返回 `SSE_NO_DELTAS`，并在报告中记录快照数、首个增量时间和响应完成时间。不发送第二次或自动重试。完成后生成 `OpenCodeRuntime/opencode-diagnostic-*.json`。

**诊断脚本启动的服务不属于 DSH 插件。** 不要将其当作默认安全模式下的 DSH 服务使用；结束诊断后按 `Ctrl+C` 关闭，再让 DSH 自动启动并拥有自己的进程。

诊断已有且自己能够认证的手动服务时使用：

```powershell
node .\scripts\doctor.mjs
node .\scripts\doctor.mjs --probe --model glm-5.3-flash-free
# 专门检查是否存在真实增量 SSE（会发起一次免费模型请求）
node .\scripts\doctor.mjs --stream-probe
```

手动服务设置了密码时，应在诊断进程环境中提供对应的 `OPENCODE_SERVER_PASSWORD`；随机生成的托管服务密码不会向其他终端公开。

### 常见错误

| 错误码 | 含义 / 处理 |
| --- | --- |
| `UNTRUSTED_OPENCODE_SERVER` | 端口由插件之外的服务占用；关闭旧服务并重启 DSH |
| `BRIDGE_AGENT_REQUIRED` | 使用了非 `dsh-bridge` Agent；恢复默认配置 |
| `GUARD_REQUIRES_MANAGED_SERVER` / `SERVER_GUARD_NOT_READY` | 安全拦截器无法在插件独占的 OpenCode 进程内正常注册；不会继续发送模型请求 |
| `SERVER_PORT_BUSY` / `SERVER_NOT_INSTALLED` | 检查端口或 OpenCode CLI 路径 |
| `AUTH` | 本地认证失败；托管服务请重启 DSH，不要使用旧密码 |
| `NETWORK_BLOCKED` / `CLIENT_RESTRICTED` | OpenCode 网关拒绝，不会绕过限制 |
| `MODEL_NOT_FOUND` / `MODEL_MISMATCH` | 服务缺少指定模型，或服务返回了其他模型 |
| `INVALID_TOOL_CALL` / `UNDECLARED_TOOL_CALL` | 模型未按协议输出，或请求了 DSH 未声明的工具 |
| `OPENCODE_TOOL_BOUNDARY` | 原生工具出现了真实执行、provider-executed 或其他不可信状态；仍坚决拒绝 |
| `NATIVE_TOOL_HISTORY_UNAVAILABLE` | SSE 工具事件无法在 OpenCode 官方只读消息历史中验证终态；请求不会交给 DSH 执行 |
| `GUARDED_TOOL_UNMAPPED` | 安全拦截正常，但第一个原生工具请求无法明确对应当前 DSH 工具定义；不会执行任何工具 |
| `SSE_NO_DELTAS` | 显式流式探针没有收到任何助手文本事件；检查 OpenCode 版本与其 SSE 发布情况 |
| `CLIENT_RESTRICTED` | 上游明确拒绝该免费模型请求；可能由服务端免费模型策略、版本或工具权限配置触发。关闭 SSE 不保证解决；不能为了让请求通过而开放 OpenCode 原生工具权限 |

网络或客户端拒绝后，当前插件实例短时冷却以避免重复请求；冷却不代表限制会自行解除。OpenCode 官方 [#51241](https://github.com/anomalyco/opencode/issues/51241) 报告过：禁止 `read` 等工具时即使官方客户端也可能遇到相同的 `CLIENT_RESTRICTED`。与本插件已确认可运行的 0.1.5 SHA `3b489e2b02e377e743f033f1dda020a100c40c70` 对照，0.1.5 为 `read: allow`，当前严格版为 `read: deny`，这是目前最具体的兼容性假设，并非已完成实测的根因结论。

### 隔离 read 兼容性测试（实验性）

仅在默认模式的普通会话仍返回 `CLIENT_RESTRICTED`、且已经停止旧手动 OpenCode 进程时，打开上面的**插件配置页**，将 **「受保护的 read 兼容模式」开启**，保存后完整重启 DSH。不要同时开启 SSE 预览，首先测试纯文本回复。

这个测试模式在模型可见配置中恢复 0.1.5 的 `read: allow`，但不授予真正的 OpenCode `read` 执行权：我们使用官方 `tool.execute.before` 钩子同步拦截所有原生工具；仅当钩子配置回调生成的随机标记被宿主确认后，才开始模型请求。没有标记或子进程非插件所有时一律失败，不降级为有实际读取权限的进程。

**重要限制**：模拟测试可以证明本地安全检查和钩子逻辑，但尚未证明 OpenCode 1.19.3 在真实 Desktop 会正常加载并应用插件，或这个模式一定解决免费模型限制。真实联测前不要执行重要工作；若请求仍被上游拒绝，应保留拒绝状态，不要开放 shell/read 的真实执行权限。

## 真实 DSH Desktop 验收

本 PR 合并前需要完成以下验证：

1. **先保持默认 `ssePreviewEnabled=false` 和 `guardedReadCompatibility=false`**，重新启动 DSH，在新会话发一个普通文本请求，确认同步旧路径是否仍可用。再手动开启 SSE 预览并重启 DSH，观察长文本是否在最终响应前持续出现。如果只有完整回复，则运行 `--stream-probe` 检查 OpenCode 的实际 SSE 事件。
2. 不带工具的普通文本问答，确认没有 OpenCode Plan/Build 角色干扰。
3. 使用 DSH 的**只读**文件工具读取测试文件，在 Trajectory 中确认执行者是 **DSH 工具运行时**。
4. 手动拒绝一次工具授权，确认未发生 OpenCode 内部执行或文件修改。
5. 在同一会话中继续提问，核对工具结果、错误标记与连续调用能够正确回传。再让模型创建 `text.txt` 并写入 `ok`，在 Trajectory 中核实调用的是 DSH `write({file_path,content})`。
6. 启用 SSE 预览生成长文本，检查最终回复不会再出现 `STREAM_MISMATCH`；检查错误路径和日志不泄露密码或跨越权限边界。

确认 SSE 增量与最终文本一致，且只读、拒绝、继续三条路径通过后才取消 Draft 并合并。

## 自动化测试

```bash
npm test
npm pack --dry-run --ignore-scripts
```

GitHub Actions 运行 Windows / Ubuntu × Node.js 22 / 24 单元测试（包括模拟 SSE 增量、工具协议缓冲、跨会话过滤、错误与最终结果校验），另在真实发布的 DSH 依赖上验证插件入口加载与注册。模拟服务和 localhost HTTP 测试**不等同于**真实 Desktop 云端联测。

## 参考

- [OpenCode Server API](https://docs.opencode.ai/docs/server/)
- [OpenCode 官方 CLI](https://docs.opencode.ai/docs/cli/)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [DSH 插件适配接口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/develop/practice/llm-adapter.md)

MIT License.
