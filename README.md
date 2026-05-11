# LLM Gateway

[English](README.md) | [Simplified Chinese](README.zh-CN.md)

LLM Gateway is a local Electron app for routing OpenAI Chat Completions and Anthropic Messages requests through configurable upstream providers. It records request/response logs, streaming events, latency, queue time, and token usage so you can inspect traffic and usage from one desktop UI.

Supported protocol paths:

- `openai -> openai`: transparent proxy for `POST /v1/chat/completions`.
- `anthropic -> anthropic`: transparent proxy for `POST /v1/messages`.
- `anthropic -> openai`: Anthropic Messages request/response adaptation to OpenAI Chat Completions.
- `openai -> anthropic`: OpenAI Chat Completions request/response adaptation to Anthropic Messages.

![LLM Gateway home screen](docs/assets/home.png)

## What It Is For

- Route OpenAI or Anthropic client requests to OpenAI-compatible or Anthropic upstream providers.
- Map incoming model names to provider/model pairs.
- Use provider-specific concurrency limits, timeouts, and API keys.
- Capture protocol traffic while developing or debugging agents, including client/provider payloads, SSE events, and protocol adaptation details.
- Inspect client request/response, provider request/response, errors, and SSE stream logs.
- Pause or resume local request logging from the sidebar.
- Review usage statistics by hour, day, or month, grouped by provider, provider model, client model, client protocol, or provider protocol.
- Import/export configuration as JSON.
- Switch the interface between English, Chinese, or automatic language detection.

## Install

Requires Node.js and npm.

```powershell
npm install
```

## Run

```powershell
npm run dev
```

The app starts a local gateway with the default address:

```text
http://127.0.0.1:3456
```

The default local token is:

```text
local-dev-token
```

Change the host, port, and local token in the Config tab.

## Client Endpoints

Anthropic-compatible clients should use:

```text
POST http://127.0.0.1:3456/v1/messages
```

OpenAI-compatible clients should use:

```text
POST http://127.0.0.1:3456/v1/chat/completions
```

Local gateway authentication accepts either:

- `Authorization: Bearer <localToken>`
- `X-Api-Key: <localToken>`

For Claude Code:

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:3456"
$env:ANTHROPIC_API_KEY="local-dev-token"
claude
```

For OpenAI-compatible clients, set the base URL to `http://127.0.0.1:3456/v1` and the API key to the gateway `localToken`.

## Configure Providers

Open the Config tab. Providers are configured as JSON.

Example:

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

Provider fields:

- `protocol`: `"openai"` or `"anthropic"`. Missing values from old configs are treated as `"openai"`.
- `baseUrl`: provider API base URL.
- `apiKey`: upstream provider API key. OpenAI providers receive `Authorization: Bearer ...`; Anthropic providers receive `X-Api-Key` and `anthropic-version`.
- `concurrency`: optional. If missing or `0`, requests are unlimited for this provider. If greater than `0`, that provider gets its own concurrency limit.
- `model_list`: optional notes for models supported by this provider. This is saved, imported, and exported, but does not affect routing.

Base URL handling for OpenAI providers:

- `https://api.example.com` becomes `https://api.example.com/v1/chat/completions`
- `https://api.example.com/v1` becomes `https://api.example.com/v1/chat/completions`
- `https://ark.cn-beijing.volces.com/api/coding/v3` becomes `https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions`
- A URL already ending in `/chat/completions` is used directly.

Base URL handling for Anthropic providers:

- `https://api.anthropic.com` becomes `https://api.anthropic.com/v1/messages`
- `https://api.anthropic.com/v1` becomes `https://api.anthropic.com/v1/messages`
- A URL already ending in `/messages` is used directly.

## Configure Model Mappings

Model mappings decide which provider/model handles each incoming model name. The incoming model can be either an Anthropic model name or an OpenAI model name.

Example:

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

The gateway first detects the client protocol from the request path, then uses `modelMappings` to choose the upstream provider and provider model. The provider's `protocol` decides whether the request is transparent proxying or cross-protocol adaptation.

If a request model is not listed in `modelMappings`, the gateway uses:

- `defaultProvider`
- `defaultModel`

and records a warning in the log.

## Logs

The left sidebar shows recent gateway requests.

For each request, the app records:

- client protocol and client model
- provider protocol, provider id, and provider model
- status code and latency
- queue wait time
- client request/response
- provider request/response
- streaming events when `stream: true`

Sensitive fields such as authorization headers and API keys are redacted when `Redact sensitive fields` is enabled.

## Usage Stats

The Stats tab summarizes completed requests.

You can choose:

- Granularity: hour, day, or month.
- Grouping: provider, provider model, client model, client protocol, or provider protocol.

The table includes request counts, success/error counts, streaming counts, input/output token totals, total tokens, average latency, and average queue wait time. Token usage is read from both OpenAI usage fields (`prompt_tokens`, `completion_tokens`) and Anthropic usage fields (`input_tokens`, `output_tokens`) when providers return them.

## Development Commands

```powershell
npm run typecheck
npm test
npm run build
```

Run the app:

```powershell
npm run dev
```

## Package For Windows

This project can be packaged with Electron tooling. See [PACKAGING.md](PACKAGING.md) for Windows `.exe` packaging notes.

## Notes

- OpenAI input currently supports `POST /v1/chat/completions`.
- Anthropic input currently supports `POST /v1/messages`.
- Tool calls and streaming responses are converted between Anthropic and OpenAI-compatible formats on the supported paths.
- Provider-specific headers beyond the built-in OpenAI and Anthropic authentication headers are not currently configurable.
