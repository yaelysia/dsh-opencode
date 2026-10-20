# dsh-opencode

通过 **OpenCode 官方 `serve` API**，把 OpenCode 模型接入 **DeepSeek Harness（DSH）** 原生模型选择器；由 DSH 执行和审批工具，OpenCode 仅负责模型推理。

**当前版本：`0.2.0-alpha.1`（实验性）。** 基本模型对话和模拟工具闭环已覆盖自动化测试，**真实 DSH Desktop + 云端模型的工具授权闭环尚未验收**。OpenCode 免费模型可能因账户、地区、网络或服务端策略而不可用，本项目不提供绕过机制。

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
- DSH 工具定义转为模型可读 JSON Schema；文本协议解析、白名单校验、工具结果及 `callId` 回传。
- 自动启动与释放插件拥有的 OpenCode 子进程；不终止未托管进程。
- 仅支持隔离的 `dsh-bridge` Agent；`plan`、`build` 和自定义 Agent 均报 `BRIDGE_AGENT_REQUIRED`，防止绕过权限边界。
- 本机随机 Basic Auth、独立运行目录、代理环境变量的子进程级处理。
- `session-title` 请求本地提取首条有效用户消息（不额外调用云模型）。

### 目前限制

- 工具调用使用**实验性单条文本协议** `DSH_TOOL_CALL_V1:{"name":"...","arguments":{...}}`，不是真正的原生 Function Calling。一次模型响应只能请求一个工具；模型未必总能遵守格式。
- 输出等待 OpenCode 返回整条消息后再转换为 DSH 流块，不是真正逐 token 流式输出。
- OpenCode `serve` 消息接口不直接接收动态 DSH 工具函数定义；温度、停止序列、最大输出 token 等请求控制目前也没有完整的原生映射，不应依赖它们得到精确语义。
- 目前只声明文本输入模型；并不提供图像输入/生成能力。
- 尚未通过真实 DSH Desktop 的授权 UI、允许/拒绝与连续工具调用验收。

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
```

该脚本在独立运行目录启动隔离服务、随机生成 Basic Auth 密码、进行健康与模型目录检查；`--probe` 才会对明确指定的免费模型发送一次固定推理请求。完成后生成 `OpenCodeRuntime/opencode-diagnostic-*.json`。

**诊断脚本启动的服务不属于 DSH 插件。** 不要将其当作默认安全模式下的 DSH 服务使用；结束诊断后按 `Ctrl+C` 关闭，再让 DSH 自动启动并拥有自己的进程。

诊断已有且自己能够认证的手动服务时使用：

```powershell
node .\scripts\doctor.mjs
node .\scripts\doctor.mjs --probe --model glm-5.3-flash-free
```

手动服务设置了密码时，应在诊断进程环境中提供对应的 `OPENCODE_SERVER_PASSWORD`；随机生成的托管服务密码不会向其他终端公开。

### 常见错误

| 错误码 | 含义 / 处理 |
| --- | --- |
| `UNTRUSTED_OPENCODE_SERVER` | 端口由插件之外的服务占用；关闭旧服务并重启 DSH |
| `BRIDGE_AGENT_REQUIRED` | 使用了非 `dsh-bridge` Agent；恢复默认配置 |
| `SERVER_PORT_BUSY` / `SERVER_NOT_INSTALLED` | 检查端口或 OpenCode CLI 路径 |
| `AUTH` | 本地认证失败；托管服务请重启 DSH，不要使用旧密码 |
| `NETWORK_BLOCKED` / `CLIENT_RESTRICTED` | OpenCode 网关拒绝，不会绕过限制 |
| `MODEL_NOT_FOUND` / `MODEL_MISMATCH` | 服务缺少指定模型，或服务返回了其他模型 |
| `INVALID_TOOL_CALL` / `UNDECLARED_TOOL_CALL` | 模型未按协议输出，或请求了 DSH 未声明的工具 |
| `OPENCODE_TOOL_BOUNDARY` | 返回了 OpenCode 原生工具事件，插件拒绝该响应 |

网络或客户端拒绝后，当前插件实例短时冷却以避免重复请求；冷却不代表网络封禁会自行解除。

## 真实 DSH Desktop 验收

本 PR 合并前需要完成以下验证：

1. 新会话进行不带工具的普通文本问答，确认没有 OpenCode Plan/Build 角色干扰。
2. 使用 DSH 的**只读**文件工具读取测试文件，在 Trajectory 中确认执行者是 **DSH 工具运行时**。
3. 手动拒绝一次工具授权，确认未发生 OpenCode 内部执行或文件修改。
4. 在同一会话中继续提问，核对工具结果、错误标记与连续调用能够正确回传。
5. 检查错误路径和日志不泄露密码或跨越权限边界。

只读、拒绝、继续三条路径均通过后才取消 Draft 并合并。

## 自动化测试

```bash
npm test
npm pack --dry-run --ignore-scripts
```

GitHub Actions 运行 Windows / Ubuntu × Node.js 22 / 24 单元测试，另在真实发布的 DSH 依赖上验证插件入口加载与注册。模拟服务和 localhost HTTP 测试**不等同于**真实 Desktop 云端联测。

## 参考

- [OpenCode Server API](https://docs.opencode.ai/docs/server/)
- [OpenCode 官方 CLI](https://docs.opencode.ai/docs/cli/)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [DSH 插件适配接口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/develop/practice/llm-adapter.md)

MIT License.
