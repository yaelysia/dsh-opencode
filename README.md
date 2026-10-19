# dsh-opencode

DSH 原生 LLM 插件，通过本地运行的 [OpenCode 官方 HTTP 服务](https://docs.opencode.ai/docs/server/) 接入模型。

## 当前状态

实验版本：代码提供模型选择、文本会话桥接和错误传递；还没有通过真实免费模型端到端验证。

本插件不直接使用 OpenCode Console 免费 API，也不保证绕过它的第三方调用限制。

## 安装和启动

先安装 OpenCode，并启动官方服务：

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

安装插件：

```sh
dsh plugin --profile desktop add "git+https://github.com/yaelysia/dsh-opencode.git#feat/native-opencode-provider"
```

重启 DSH，在模型选择器中寻找 OpenCode (official serve)。

默认模型：

- deepseek-v4.1-flash-free
- glm-5.3-flash-free

默认服务地址为 http://127.0.0.1:4096，默认使用 OpenCode plan agent。可配置 endpoint、models、agent 和 backendProviderId。

如官方服务启用了 Basic Auth，在运行 DSH 的环境中设置 OPENCODE_SERVER_PASSWORD。

## 当前限制

- 目前只将文本响应转换为 DSH 模型分片，未完成 DSH 工具调用双向映射。
- 官方服务返回完整结果后才输出内容，并非逐 token 流式传输。
- 如果 OpenCode 服务端拒绝免费模型请求，此插件仍会报告相应错误。
- 使用 OpenCode plan agent，不代表 OpenCode 内部工具受 DSH 审批机制管理。

运行离线测试：`npm test`。

实现遵循 [DSH Bundle 安装规范](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。

## 排错

OpenCode 在 HTTP 200 的 `info.error` 中仍可能返回模型失败；本插件会将它报告为 DSH 失败并写入 DSH 日志，空文本也不会被当作成功。

1. 检查服务：`Invoke-RestMethod http://127.0.0.1:4096/global/health`。
2. 在 DSH 新会话中使用模型并观察失败信息；如果出现 `OpenCode APIError`、403 或 `EMPTY_RESPONSE`，检查 OpenCode 官方服务日志。
3. Wire Trace 不是完整的请求日志。此版本向本地 OpenCode API 发送 DSH 标准 User-Agent，但是否显示还取决于 DSH 捕获器。

如果官方 OpenCode 客户端调用同一免费模型也返回 403，则故障发生在 OpenCode 免费车道，更新 DSH 插件无法解除服务端限制。

### 免费模型网关按出口 IP 拒绝

若 DSH 显示 `FORBIDDEN`，并包含 `OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address`，这是 OpenCode 云端免费车道针对出口 IP 的限制，不是 DSH 的 `/models` 404、模型 ID 或本地 `opencode serve` HTTP 协议错误。此类情况下，本地 `/session/:id/message` 返回 HTTP 200，仍可能在响应的 `info.error` 中包含网关拒绝信息。

OpenCode 维护方在 [issue #56853](https://github.com/anomalyco/opencode/issues/56853) 中确认该限制由免费模型网关做出；是否自动过期或解封需官方确认，建议停止异常高频请求、检查是否使用 VPN/代理，并联系 `help@anoma.ly` 申请审核。不要通过修改本插件的请求头或增加重试次数尝试规避 IP 限制。
