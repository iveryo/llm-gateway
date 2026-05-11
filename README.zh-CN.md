# LLM Gateway

[English](README.md) | [简体中文](README.zh-CN.md)

LLM Gateway 是一个本地 Electron 应用，用于把 OpenAI Chat Completions 和 Anthropic Messages 请求转发到可配置的上游服务商。它会记录请求、响应、流式事件、延迟、排队时间和 token 用量，方便在桌面界面里检查流量和统计。

支持的协议路径：

- `openai -> openai`：`POST /v1/chat/completions` 透明代理。
- `anthropic -> anthropic`：`POST /v1/messages` 透明代理。
- `anthropic -> openai`：Anthropic Messages 与 OpenAI Chat Completions 之间的协议适配。
- `openai -> anthropic`：OpenAI Chat Completions 与 Anthropic Messages 之间的协议适配。

![LLM Gateway 首页](docs/assets/home.png)

## 适用场景

- 将 OpenAI 或 Anthropic 客户端请求路由到 OpenAI 兼容服务商或 Anthropic 服务商。
- 将入口模型名映射到指定的 provider/model。
- 为不同服务商配置并发限制、超时和 API key。
- 作为 Agent 开发调试时的协议捕捉工具，捕获客户端与上游之间的请求、响应、SSE 流和协议转换细节。
- 查看客户端请求/响应、上游请求/响应、错误和 SSE 流日志。
- 在侧边栏暂停或恢复本地日志记录。
- 按小时、天或月查看用量统计，并按服务商、服务商模型、客户端模型、客户端协议或上游协议分组。
- 以 JSON 导入或导出配置。
- 在英文、中文和自动语言检测之间切换界面语言。

## 安装

需要 Node.js 和 npm。

```powershell
npm install
```

## 运行

```powershell
npm run dev
```

默认本地网关地址：

```text
http://127.0.0.1:3456
```

默认本地令牌：

```text
local-dev-token
```

可以在 Config 标签页修改 host、port 和 local token。

## 客户端入口

Anthropic 兼容客户端使用：

```text
POST http://127.0.0.1:3456/v1/messages
```

OpenAI 兼容客户端使用：

```text
POST http://127.0.0.1:3456/v1/chat/completions
```

本地网关鉴权接受两种请求头：

- `Authorization: Bearer <localToken>`
- `X-Api-Key: <localToken>`

Claude Code 示例：

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:3456"
$env:ANTHROPIC_API_KEY="local-dev-token"
claude
```

OpenAI 兼容客户端可以把 base URL 设置为 `http://127.0.0.1:3456/v1`，API key 设置为网关的 `localToken`。

## 配置服务商

打开 Config 标签页。服务商使用 JSON 配置。

示例：

```json
{
  "openai": {
    "protocol": "openai",
    "baseUrl": "https://api.openai.com",
    "apiKey": "sk-...",
    "model_list": ["gpt-4o", "gpt-4o-mini"]
  },
  "anthropic": {
    "protocol": "anthropic",
    "baseUrl": "https://api.anthropic.com",
    "apiKey": "sk-ant-...",
    "model_list": ["claude-sonnet-4-5", "claude-3-5-haiku-latest"]
  },
  "ark": {
    "protocol": "openai",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
    "apiKey": "your-ark-key",
    "concurrency": 2,
    "model_list": ["doubao-seed-1-6", "kimi-k2-250905"]
  }
}
```

服务商字段：

- `protocol`：`"openai"` 或 `"anthropic"`。旧配置缺少该字段时会按 `"openai"` 处理。
- `baseUrl`：服务商 API 基础地址。
- `apiKey`：上游服务商 API key。OpenAI provider 使用 `Authorization: Bearer ...`；Anthropic provider 使用 `X-Api-Key` 和 `anthropic-version`。
- `concurrency`：可选。缺失或为 `0` 时不限制该服务商并发；大于 `0` 时使用该服务商自己的并发限制。
- `model_list`：可选的模型备注，会被保存、导入和导出，但不影响路由。

OpenAI provider 的 base URL 规则：

- `https://api.example.com` 会变为 `https://api.example.com/v1/chat/completions`
- `https://api.example.com/v1` 会变为 `https://api.example.com/v1/chat/completions`
- `https://ark.cn-beijing.volces.com/api/coding/v3` 会变为 `https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions`
- 已经以 `/chat/completions` 结尾的 URL 会直接使用。

Anthropic provider 的 base URL 规则：

- `https://api.anthropic.com` 会变为 `https://api.anthropic.com/v1/messages`
- `https://api.anthropic.com/v1` 会变为 `https://api.anthropic.com/v1/messages`
- 已经以 `/messages` 结尾的 URL 会直接使用。

## 配置模型映射

模型映射决定每个入口模型名由哪个 provider/model 处理。入口模型名可以是 Anthropic 模型名，也可以是 OpenAI 模型名。

示例：

```json
{
  "claude-sonnet-4-5": {
    "provider": "openai",
    "model": "gpt-4o"
  },
  "gpt-4o": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "gpt-4o-mini": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  }
}
```

网关先根据请求路径识别客户端协议，再通过 `modelMappings` 选择上游 provider 和上游模型。provider 的 `protocol` 决定是透明代理还是跨协议适配。

如果请求模型没有出现在 `modelMappings` 中，网关会使用：

- `defaultProvider`
- `defaultModel`

并在日志里记录 warning。

## 日志

左侧边栏显示最近的网关请求。

每个请求会记录：

- 客户端协议和客户端模型
- 上游协议、provider id 和 provider model
- 状态码和延迟
- 排队等待时间
- 客户端请求/响应
- 上游请求/响应
- `stream: true` 时的流式事件

启用 `Redact sensitive fields` 后，authorization 请求头、API key 等敏感字段会被隐藏。

## 用量统计

Stats 标签页会汇总已完成请求。

可以选择：

- 粒度：小时、天或月。
- 分组：服务商、服务商模型、客户端模型、客户端协议或上游协议。

统计表包含请求数、成功/错误数、流式请求数、输入/输出 token、总 token、平均延迟和平均排队等待时间。token 用量会同时识别 OpenAI 的 `prompt_tokens` / `completion_tokens` 和 Anthropic 的 `input_tokens` / `output_tokens`。

## 开发命令

```powershell
npm run typecheck
npm test
npm run build
```

运行应用：

```powershell
npm run dev
```

## Windows 打包

本项目可以使用 Electron 工具链打包。Windows `.exe` 打包说明见 [PACKAGING.zh-CN.md](PACKAGING.zh-CN.md)。

## 备注

- OpenAI 入口当前支持 `POST /v1/chat/completions`。
- Anthropic 入口当前支持 `POST /v1/messages`。
- 工具调用和流式响应会在支持的路径上进行 Anthropic 与 OpenAI 兼容格式转换。
- 当前暂不支持配置内置 OpenAI/Anthropic 鉴权头之外的服务商专用请求头。
