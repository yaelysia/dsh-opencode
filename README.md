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
dsh plugin --profile desktop add github:yaelysia/dsh-opencode
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
