import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, GatewayConfig } from "../shared/types.js";
import {
  anthropicEventsToMessage,
  anthropicStreamToEvents,
  anthropicStreamToOpenAIChunks,
  anthropicToOpenAI,
  anthropicToOpenAIResponse,
  openAIRequestToAnthropic,
  openAISseFormat,
  openAIStreamToAnthropicEvents,
  openAIStreamToJson,
  openAIToAnthropic
} from "./protocol.js";
import { providerChatCompletionsUrl, providerMessagesUrl } from "./provider.js";

const config: GatewayConfig = {
  ...DEFAULT_CONFIG,
  defaultProvider: "cheap",
  defaultModel: "provider-default",
  providers: {
    openai: { protocol: "openai", baseUrl: "https://api.openai.com", apiKey: "openai-key", concurrency: 2 },
    cheap: { protocol: "openai", baseUrl: "https://api.cheap.example", apiKey: "cheap-key" },
    anthropic: { protocol: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "anthropic-key" }
  },
  modelMappings: {
    "claude-test": { provider: "openai", model: "provider-test" },
    "gpt-test": { provider: "anthropic", model: "claude-provider-test" }
  }
};

describe("protocol conversion", () => {
  it("converts Anthropic text messages to OpenAI chat completions", () => {
    const converted = anthropicToOpenAI(
      {
        model: "claude-test",
        system: "You are concise.",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }]
      },
      config
    );

    expect(converted.providerModel).toBe("provider-test");
    expect(converted.providerId).toBe("openai");
    expect(converted.request).toMatchObject({
      model: "provider-test",
      max_tokens: 100,
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Hello" }
      ]
    });
  });

  it("falls back to the default provider and model when a mapping is missing", () => {
    const converted = anthropicToOpenAI(
      {
        model: "claude-unmapped",
        messages: [{ role: "user", content: "Hello" }]
      },
      config
    );

    expect(converted.providerId).toBe("cheap");
    expect(converted.providerModel).toBe("provider-default");
    expect(converted.warning).toBe("No model mapping for claude-unmapped; used cheap/provider-default");
    expect(converted.request).toMatchObject({ model: "provider-default" });
  });

  it("maps Anthropic tools and tool results to OpenAI tool calls", () => {
    const converted = anthropicToOpenAI(
      {
        model: "claude-test",
        tools: [{ name: "read_file", input_schema: { type: "object" } }],
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } }]
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]
          }
        ]
      },
      config
    );

    expect(converted.request).toMatchObject({
      tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "toolu_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }]
        },
        { role: "tool", tool_call_id: "toolu_1", content: "ok" }
      ]
    });
  });

  it("converts OpenAI responses to Anthropic message responses", () => {
    const response = openAIToAnthropic(
      {
        id: "chatcmpl_1",
        choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "call_1", function: { name: "search", arguments: "{\"q\":\"x\"}" } }] } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 }
      },
      "provider-test"
    );

    expect(response).toMatchObject({
      id: "chatcmpl_1",
      model: "provider-test",
      stop_reason: "tool_use",
      usage: { input_tokens: 12, output_tokens: 4 },
      content: [{ type: "tool_use", id: "call_1", name: "search", input: { q: "x" } }]
    });
  });

  it("converts OpenAI chat completions requests to Anthropic messages", () => {
    const converted = openAIRequestToAnthropic(
      {
        model: "gpt-test",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{\"q\":\"x\"}" } }]
          },
          { role: "tool", tool_call_id: "call_1", content: "result" }
        ],
        tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
        tool_choice: { type: "function", function: { name: "search" } },
        max_tokens: 50
      },
      config
    );

    expect(converted.providerId).toBe("anthropic");
    expect(converted.providerModel).toBe("claude-provider-test");
    expect(converted.request).toMatchObject({
      model: "claude-provider-test",
      max_tokens: 50,
      system: "Be brief.",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "search", input: { q: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }] }
      ],
      tools: [{ name: "search", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "search" }
    });
  });

  it("converts Anthropic message responses to OpenAI chat completions", () => {
    const response = anthropicToOpenAIResponse(
      {
        id: "msg_1",
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "toolu_1", name: "search", input: { q: "x" } }
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 8, output_tokens: 3 }
      },
      "gpt-test"
    );

    expect(response).toMatchObject({
      id: "msg_1",
      model: "gpt-test",
      choices: [{
        message: {
          role: "assistant",
          content: "Hello",
          tool_calls: [{ id: "toolu_1", type: "function", function: { name: "search", arguments: "{\"q\":\"x\"}" } }]
        },
        finish_reason: "tool_calls"
      }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }
    });
  });

  it("does not duplicate /v1 when provider base URL already includes it", () => {
    expect(providerChatCompletionsUrl("https://api.example.com")).toBe("https://api.example.com/v1/chat/completions");
    expect(providerChatCompletionsUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/chat/completions");
    expect(providerChatCompletionsUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1/chat/completions");
  });

  it("supports provider base URLs that already include a versioned API path", () => {
    expect(providerChatCompletionsUrl("https://ark.cn-beijing.volces.com/api/coding/v3")).toBe(
      "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions"
    );
    expect(providerChatCompletionsUrl("https://api.example.com/openai/v2/")).toBe("https://api.example.com/openai/v2/chat/completions");
    expect(providerChatCompletionsUrl("https://api.example.com/custom/chat/completions")).toBe(
      "https://api.example.com/custom/chat/completions"
    );
  });

  it("builds Anthropic messages URLs without duplicating /v1", () => {
    expect(providerMessagesUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/messages");
    expect(providerMessagesUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1/messages");
    expect(providerMessagesUrl("https://api.example.com/custom/v2/")).toBe("https://api.example.com/custom/v2/messages");
    expect(providerMessagesUrl("https://api.example.com/custom/messages")).toBe("https://api.example.com/custom/messages");
  });

  it("converts OpenAI SSE chunks to Anthropic SSE events", () => {
    const events = openAIStreamToAnthropicEvents(
      [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
        "data: [DONE]"
      ],
      "provider-test"
    );

    expect(events.map((event: any) => event.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
  });

  it("aggregates OpenAI SSE chunks into provider and Anthropic JSON logs", () => {
    const lines = [
      'data: {"id":"chatcmpl_1","model":"provider-test","choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"id":"chatcmpl_1","model":"provider-test","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      "data: [DONE]"
    ];
    const providerJson = openAIStreamToJson(lines);
    const anthropicMessage = anthropicEventsToMessage(openAIStreamToAnthropicEvents(lines, "claude-test"));

    expect(providerJson).toMatchObject({
      id: "chatcmpl_1",
      model: "provider-test",
      choices: [{ message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }]
    });
    expect(anthropicMessage).toMatchObject({
      model: "claude-test",
      content: [{ type: "text", text: "Hello" }],
      stop_reason: "end_turn"
    });
  });

  it("converts Anthropic SSE events to OpenAI SSE chunks", () => {
    const events = anthropicStreamToEvents([
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-provider-test","usage":{"input_tokens":7,"output_tokens":0}}}',
      "",
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      "",
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      "",
      'event: message_stop',
      'data: {"type":"message_stop"}',
      ""
    ]);
    const chunks = anthropicStreamToOpenAIChunks(events, "gpt-test");
    const json = openAIStreamToJson(openAISseFormat(chunks).split(/\r?\n/));

    expect(json).toMatchObject({
      model: "gpt-test",
      choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }
    });
  });
});
