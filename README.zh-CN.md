# LLM Gateway

[English](README.md) | [简体中文](README.zh-CN.md)

LLM Gateway 是一个本地 Electron 应用，用于让 Claude Code 通过 Anthropic Messages API 的请求格式调用 OpenAI 兼容服务商。

它在本地接收 `POST /v1/messages` 请求，将 Claude/Anthropic 请求转换为 OpenAI Chat Completions 请求，发送到已配置的服务商，再把响应转换回 Anthropic 格式。应用内也提供请求和响应日志，方便检查路由、载荷、错误和流式事件。

![LLM Gateway 首页](docs/assets/home.png)

## 适用场景

- 将 Claude Code 请求路由到 OpenAI 兼容服务商。
- 将不同 Claude 模型名映射到不同服务商模型。
- 为简单 Claude Code 任务使用更便宜的服务商或模型，为复杂任务使用更强的模型。
- 配置每个服务商的 base URL、API key、可选并发限制和模型备注。
- 以 JSON 导入或导出配置。
- 查看 Anthropic 请求、服务商请求、服务商响应、Anthropic 响应和 SSE 流日志。
- 在侧边栏暂停或恢复本地请求日志记录。
- 按小时、天或月查看用量统计，并按服务商、服务商模型或 Claude 模型分组。
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

应用会启动本地网关，默认地址为：

```text
http://127.0.0.1:3456
```

默认本地令牌为：

```text
local-dev-token
```

可以在 Config 标签页修改主机、端口和本地令牌。

## 连接 Claude Code

Claude Code 支持通过 `ANTHROPIC_BASE_URL` 将请求转发到网关，并通过 `ANTHROPIC_API_KEY` 设置 `X-Api-Key` 请求头。

PowerShell：

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:3456"
$env:ANTHROPIC_API_KEY="local-dev-token"
claude
```

macOS/Linux：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3456"
export ANTHROPIC_API_KEY="local-dev-token"
claude
```

`ANTHROPIC_API_KEY` 的值必须与网关配置中的 `localToken` 一致。

Claude Code 官方环境变量参考：https://code.claude.com/docs/en/env-vars

## 配置服务商

打开 Config 标签页。服务商使用 JSON 配置。

示例：

```json
{
  "openai": {
    "baseUrl": "https://api.openai.com",
    "apiKey": "sk-...",
    "model_list": ["gpt-4o", "gpt-4o-mini"]
  },
  "ark": {
    "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
    "apiKey": "your-ark-key",
    "concurrency": 2,
    "model_list": ["doubao-seed-1-6", "kimi-k2-250905"]
  },
  "cheap": {
    "baseUrl": "https://api.example.com",
    "apiKey": "your-provider-key",
    "concurrency": 0,
    "model_list": ["fast-model", "budget-model"]
  }
}
```

服务商字段：

- `baseUrl`：OpenAI 兼容 API 的基础地址。
- `apiKey`：以 `Authorization: Bearer ...` 形式发送给该服务商的 API key。
- `concurrency`：可选。缺失或为 `0` 时，该服务商不限制并发；大于 `0` 时，该服务商使用独立并发限制。
- `model_list`：可选的模型备注，会参与保存、导入和导出，但不影响路由。

Base URL 处理规则：

- `https://api.example.com` 会变为 `https://api.example.com/v1/chat/completions`
- `https://api.example.com/v1` 会变为 `https://api.example.com/v1/chat/completions`
- `https://ark.cn-beijing.volces.com/api/coding/v3` 会变为 `https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions`
- 已经以 `/chat/completions` 结尾的 URL 会被直接使用。

## 配置模型映射

模型映射决定每个 Claude 模型名由哪个服务商和模型处理。

示例：

```json
{
  "claude-sonnet-4-5": {
    "provider": "openai",
    "model": "gpt-4o"
  },
  "claude-3-5-haiku-latest": {
    "provider": "cheap",
    "model": "budget-model"
  }
}
```

如果请求中的模型没有出现在 `modelMappings` 中，网关会使用：

- `defaultProvider`
- `defaultModel`

并在日志中记录一条 warning。

## 导入和导出配置

在 Config 标签页：

- `Export JSON` 会将当前表单状态下载为 JSON 文件。
- `Import JSON` 会将 JSON 文件加载到表单。
- 导入的配置只有在点击 `Save and restart gateway` 后才会生效。

保存错误会显示在按钮旁边。例如，如果 `defaultProvider` 是 `openai`，但 `providers` 中没有 `openai`，界面会显示：

```text
Default provider "openai" is not configured
```

## 日志

左侧边栏显示最近的网关请求。

每个请求会记录：

- Claude 模型
- 服务商 ID
- 服务商模型
- 状态码和延迟
- 排队等待时间
- Anthropic 请求和响应
- OpenAI 兼容服务商请求和响应
- `stream: true` 时的流式事件

启用 `Redact sensitive fields` 后，authorization 请求头、API key 等敏感字段会被隐藏。

## 用量统计

Stats 标签页会汇总已完成请求。

你可以选择：

- 粒度：小时、天或月。
- 分组：服务商、服务商模型或 Claude 模型。

统计表包含请求数、成功/错误数、流式请求数、输入/输出 token、总 token、平均延迟和平均排队等待时间。流式 OpenAI 兼容请求会携带 `stream_options.include_usage`，支持该能力的服务商可以返回 token 用量。

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

- 当前网关支持 Anthropic `POST /v1/messages`。
- 服务商 API 必须兼容 OpenAI Chat Completions。
- 工具调用和流式响应会在 Anthropic 与 OpenAI 兼容格式之间转换。
- 当前暂不支持配置 bearer API key 之外的服务商专用请求头。
