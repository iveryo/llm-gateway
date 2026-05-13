import { GatewayConfig } from "../shared/types.js";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

type AnthropicRequest = {
  model?: string;
  system?: string | Array<{ type: "text"; text: string }>;
  messages?: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: { type: string; name?: string };
};

type OpenAIMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; type?: "function"; function?: { name?: string; arguments?: string } }>;
};

type OpenAIRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>;
  tool_choice?: string | { type?: string; function?: { name?: string } };
};

export type ModelRoute = {
  clientModel: string;
  providerId: string;
  providerModel: string;
  warning?: string;
};

export function resolveModelRoute(model: string | undefined, config: GatewayConfig): ModelRoute {
  const clientModel = model ?? "";
  const mapping = config.modelMappings[clientModel];
  const providerId = mapping?.provider ?? config.defaultProvider;
  const providerModel = mapping?.model ?? config.defaultModel;
  const warning = clientModel && !mapping
    ? `No model mapping for ${clientModel}; used ${providerId}/${providerModel}`
    : undefined;

  return {
    clientModel,
    providerId,
    providerModel,
    warning
  };
}

export function anthropicToOpenAI(body: AnthropicRequest, config: GatewayConfig) {
  const route = resolveModelRoute(body.model, config);
  const messages: OpenAIMessage[] = [];
  const system = normalizeSystem(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of body.messages ?? []) {
    messages.push(...convertAnthropicMessage(message));
  }

  const request: Record<string, unknown> = {
    model: route.providerModel,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    stream: Boolean(body.stream)
  };

  if (body.stream) {
    request.stream_options = { include_usage: true };
  }

  if (body.tools?.length) {
    request.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.input_schema ?? { type: "object", properties: {} }
      }
    }));
  }

  if (body.tool_choice) {
    request.tool_choice = anthropicToolChoiceToOpenAI(body.tool_choice);
  }

  return {
    anthropicModel: route.clientModel,
    clientModel: route.clientModel,
    providerId: route.providerId,
    providerModel: route.providerModel,
    warning: route.warning,
    request: stripUndefined(request)
  };
}

export function openAIRequestToAnthropic(body: OpenAIRequest, config: GatewayConfig) {
  const route = resolveModelRoute(body.model, config);
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const message of body.messages ?? []) {
    if (message.role === "system" || message.role === "developer") {
      const text = openAIContentToText(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.tool_call_id ?? "",
          content: openAIContentToText(message.content)
        }]
      });
      continue;
    }

    if (message.role === "assistant") {
      const content = openAIAssistantContentToAnthropic(message);
      messages.push({ role: "assistant", content });
      continue;
    }

    messages.push({
      role: "user",
      content: openAIContentToText(message.content)
    });
  }

  const request: Record<string, unknown> = {
    model: route.providerModel,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 4096,
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages,
    temperature: body.temperature,
    top_p: body.top_p,
    stop_sequences: normalizeOpenAIStop(body.stop),
    stream: Boolean(body.stream)
  };

  if (body.tools?.length) {
    request.tools = body.tools
      .filter((tool) => tool.type === "function" || tool.function)
      .map((tool) => ({
        name: tool.function?.name ?? "",
        description: tool.function?.description ?? "",
        input_schema: tool.function?.parameters ?? { type: "object", properties: {} }
      }))
      .filter((tool) => tool.name);
  }

  if (body.tool_choice) {
    request.tool_choice = openAIToolChoiceToAnthropic(body.tool_choice);
  }

  return {
    clientModel: route.clientModel,
    providerId: route.providerId,
    providerModel: route.providerModel,
    warning: route.warning,
    request: stripUndefined(request)
  };
}

export function openAITransparentRequest(body: OpenAIRequest, providerModel: string) {
  return {
    ...body,
    model: providerModel
  };
}

export function anthropicTransparentRequest(body: AnthropicRequest, providerModel: string) {
  return {
    ...body,
    model: providerModel
  };
}

export function openAIToAnthropic(body: any, responseModel: string) {
  const choice = body?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = openAIMessageToAnthropicContent(message);
  return {
    id: body?.id ?? `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: responseModel,
    content,
    stop_reason: finishReasonToAnthropic(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: body?.usage?.prompt_tokens ?? 0,
      output_tokens: body?.usage?.completion_tokens ?? 0
    }
  };
}

export function anthropicToOpenAIResponse(body: any, responseModel: string) {
  const message = anthropicContentToOpenAIMessage(body?.content);
  return {
    id: body?.id ?? `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: responseModel,
    choices: [{
      index: 0,
      message,
      finish_reason: anthropicStopReasonToOpenAI(body?.stop_reason)
    }],
    usage: {
      prompt_tokens: body?.usage?.input_tokens ?? 0,
      completion_tokens: body?.usage?.output_tokens ?? 0,
      total_tokens: (body?.usage?.input_tokens ?? 0) + (body?.usage?.output_tokens ?? 0)
    }
  };
}

export function openAIStreamToAnthropicEvents(lines: string[], providerModel: string): unknown[] {
  const messageId = `msg_${crypto.randomUUID()}`;
  const messageStart = {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: providerModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }
  };
  const events: unknown[] = [messageStart];

  let thinkingBlockOpen = false;
  let thinkingIndex = 0;
  let textBlockOpen = false;
  let textIndex = 0;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string; index: number }>();
  let nextBlockIndex = 0;
  let stopReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  const stopThinkingBlock = () => {
    if (!thinkingBlockOpen) return;
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: thinkingIndex } });
    thinkingBlockOpen = false;
  };

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    const chunk = JSON.parse(payload);
    if (chunk.usage) {
      inputTokens = numberValue(chunk.usage.prompt_tokens) ?? inputTokens;
      outputTokens = numberValue(chunk.usage.completion_tokens) ?? outputTokens;
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? {};
    if (choice?.finish_reason) stopReason = finishReasonToAnthropic(choice.finish_reason);

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      if (!thinkingBlockOpen) {
        thinkingIndex = nextBlockIndex++;
        thinkingBlockOpen = true;
        events.push({
          event: "content_block_start",
          data: { type: "content_block_start", index: thinkingIndex, content_block: { type: "thinking", thinking: "" } }
        });
      }
      events.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index: thinkingIndex, delta: { type: "thinking_delta", thinking: delta.reasoning_content } }
      });
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      stopThinkingBlock();
      if (!textBlockOpen) {
        textIndex = nextBlockIndex++;
        textBlockOpen = true;
        events.push({
          event: "content_block_start",
          data: { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } }
        });
      }
      events.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: delta.content } }
      });
    }

    for (const call of delta.tool_calls ?? []) {
      stopThinkingBlock();
      const index = call.index ?? 0;
      const existing = toolCalls.get(index);
      if (!existing) {
        const blockIndex = nextBlockIndex++;
        const created = {
          id: call.id ?? `call_${crypto.randomUUID()}`,
          name: call.function?.name ?? "",
          arguments: call.function?.arguments ?? "",
          index: blockIndex
        };
        toolCalls.set(index, created);
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "tool_use", id: created.id, name: created.name, input: {} }
          }
        });
        if (created.arguments) {
          events.push(toolInputDelta(blockIndex, created.arguments));
        }
      } else {
        if (call.function?.name) existing.name += call.function.name;
        if (call.function?.arguments) {
          existing.arguments += call.function.arguments;
          events.push(toolInputDelta(existing.index, call.function.arguments));
        }
      }
    }
  }

  messageStart.data.message.usage.input_tokens = inputTokens;
  stopThinkingBlock();
  if (textBlockOpen) {
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: textIndex } });
  }
  for (const call of toolCalls.values()) {
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: call.index } });
  }

  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: outputTokens }
    }
  });
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return events;
}

export function anthropicStreamToOpenAIChunks(events: unknown[], responseModel: string): unknown[] {
  const created = Math.floor(Date.now() / 1000);
  let id = `chatcmpl_${crypto.randomUUID()}`;
  let finishReason: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let nextToolIndex = 0;
  const toolIndexes = new Map<number, number>();
  const chunks: unknown[] = [];

  for (const event of events as any[]) {
    if (event.event === "message_start") {
      const message = event.data?.message ?? {};
      id = message.id ? `chatcmpl_${message.id}` : id;
      promptTokens = numberValue(message.usage?.input_tokens) ?? promptTokens;
      chunks.push(openAIChunk(id, created, responseModel, { role: "assistant" }, null));
      continue;
    }

    if (event.event === "content_block_start") {
      const block = event.data?.content_block;
      if (block?.type !== "tool_use") continue;
      const toolIndex = nextToolIndex++;
      toolIndexes.set(event.data.index, toolIndex);
      chunks.push(openAIChunk(id, created, responseModel, {
        tool_calls: [{
          index: toolIndex,
          id: block.id ?? `call_${crypto.randomUUID()}`,
          type: "function",
          function: { name: block.name ?? "", arguments: "" }
        }]
      }, null));
      continue;
    }

    if (event.event === "content_block_delta") {
      const delta = event.data?.delta;
      if (delta?.type === "text_delta") {
        chunks.push(openAIChunk(id, created, responseModel, { content: delta.text ?? "" }, null));
      }
      if (delta?.type === "input_json_delta") {
        const toolIndex = toolIndexes.get(event.data.index) ?? 0;
        chunks.push(openAIChunk(id, created, responseModel, {
          tool_calls: [{
            index: toolIndex,
            function: { arguments: delta.partial_json ?? "" }
          }]
        }, null));
      }
      continue;
    }

    if (event.event === "message_delta") {
      finishReason = anthropicStopReasonToOpenAI(event.data?.delta?.stop_reason);
      completionTokens = numberValue(event.data?.usage?.output_tokens) ?? completionTokens;
      chunks.push(openAIChunk(id, created, responseModel, {}, finishReason));
    }
  }

  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: responseModel,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  });

  return chunks;
}

export function openAIStreamToJson(lines: string[]) {
  const toolCalls = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
  let id = `chatcmpl_${crypto.randomUUID()}`;
  let model = "";
  let reasoningContent = "";
  let content = "";
  let finishReason: string | null = null;
  let usage: unknown;

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    const chunk = JSON.parse(payload);
    id = chunk.id ?? id;
    model = chunk.model ?? model;
    usage = chunk.usage ?? usage;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? {};
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
    if (typeof delta.content === "string") content += delta.content;

    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      const existing = toolCalls.get(index);
      if (!existing) {
        toolCalls.set(index, {
          id: call.id ?? `call_${crypto.randomUUID()}`,
          type: "function",
          function: {
            name: call.function?.name ?? "",
            arguments: call.function?.arguments ?? ""
          }
        });
      } else {
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.function.name += call.function.name;
        if (call.function?.arguments) existing.function.arguments += call.function.arguments;
      }
    }
  }

  const message: Record<string, unknown> = { role: "assistant", content: content || null };
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.values()];
  }

  return stripUndefined({
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || undefined,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage
  });
}

export function anthropicStreamToEvents(lines: string[]): unknown[] {
  const events: unknown[] = [];
  let eventName = "";
  let dataLines: string[] = [];

  const flush = () => {
    if (!eventName && dataLines.length === 0) return;
    const dataText = dataLines.join("\n");
    let data: unknown = dataText;
    try {
      data = dataText ? JSON.parse(dataText) : {};
    } catch {
      data = dataText;
    }
    events.push({ event: eventName || (data as any)?.type || "message", data });
    eventName = "";
    dataLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  flush();
  return events;
}

export function anthropicEventsToMessage(events: unknown[]) {
  const firstMessage = events.find((event: any) => event.event === "message_start") as any;
  const message = structuredClone(firstMessage?.data?.message ?? {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: "",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 }
  });
  const blocks = new Map<number, any>();

  for (const event of events as any[]) {
    if (event.event === "content_block_start") {
      blocks.set(event.data.index, structuredClone(event.data.content_block));
    }
    if (event.event === "content_block_delta") {
      const block = blocks.get(event.data.index);
      if (!block) continue;
      if (event.data.delta.type === "text_delta") {
        block.text = `${block.text ?? ""}${event.data.delta.text ?? ""}`;
      }
      if (event.data.delta.type === "thinking_delta") {
        block.thinking = `${block.thinking ?? ""}${event.data.delta.thinking ?? ""}`;
      }
      if (event.data.delta.type === "input_json_delta") {
        block._partial_json = `${block._partial_json ?? ""}${event.data.delta.partial_json ?? ""}`;
      }
    }
    if (event.event === "message_delta") {
      message.stop_reason = event.data.delta?.stop_reason ?? message.stop_reason;
      message.stop_sequence = event.data.delta?.stop_sequence ?? message.stop_sequence;
      message.usage = { ...message.usage, ...event.data.usage };
    }
  }

  message.content = [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => {
      if (block.type === "tool_use") {
        const partialJson = block._partial_json;
        delete block._partial_json;
        block.input = parseJsonObject(partialJson);
      }
      return block;
    });
  return message;
}

export function sseFormat(events: unknown[]): string {
  return events.map((event: any) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join("");
}

export function openAISseFormat(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = /authorization|api[-_]?key|x-api-key/i.test(key) ? "[REDACTED]" : redact(nested);
  }
  return output;
}

function normalizeSystem(system: AnthropicRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
}

function convertAnthropicMessage(message: AnthropicMessage): OpenAIMessage[] {
  if (typeof message.content === "string") {
    return [{ role: message.role, content: message.content }];
  }

  const result: OpenAIMessage[] = [];
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
  const toolUses = message.content.filter((block): block is Extract<AnthropicContentBlock, { type: "tool_use" }> => block.type === "tool_use");
  if (text || toolUses.length || message.role === "assistant") {
    result.push({
      role: message.role,
      content: text || null,
      tool_calls: toolUses.length
        ? toolUses.map((block) => ({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
          }))
        : undefined
    });
  }

  for (const block of message.content) {
    if (block.type === "tool_result") {
      result.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "")
      });
    }
  }

  return result.map((item) => stripUndefined(item) as OpenAIMessage);
}

function openAIAssistantContentToAnthropic(message: OpenAIMessage): AnthropicMessage["content"] {
  const content: AnthropicContentBlock[] = [];
  const text = openAIContentToText(message.content);
  if (text) content.push({ type: "text", text });

  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id ?? `call_${crypto.randomUUID()}`,
      name: call.function?.name ?? "",
      input: parseJsonObject(call.function?.arguments)
    });
  }

  if (content.length === 1 && content[0].type === "text") return content[0].text;
  return content;
}

function openAIContentToText(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object") return String(part ?? "");
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (typeof record.text === "string") return record.text;
      return JSON.stringify(record);
    }).filter(Boolean).join("");
  }
  return JSON.stringify(content);
}

function openAIMessageToAnthropicContent(message: any): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  if (message.reasoning_content) blocks.push({ type: "thinking", thinking: String(message.reasoning_content) });
  if (message.content) blocks.push({ type: "text", text: String(message.content) });
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name ?? "",
      input: parseJsonObject(call.function?.arguments)
    });
  }
  return blocks;
}

function anthropicContentToOpenAIMessage(content: unknown): Record<string, unknown> {
  if (typeof content === "string") {
    return { role: "assistant", content };
  }

  const text: string[] = [];
  const toolCalls: unknown[] = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text") {
      text.push(String(record.text ?? ""));
    }
    if (record.type === "tool_use") {
      toolCalls.push({
        id: String(record.id ?? `call_${crypto.randomUUID()}`),
        type: "function",
        function: {
          name: String(record.name ?? ""),
          arguments: JSON.stringify(record.input ?? {})
        }
      });
    }
  }

  return stripUndefined({
    role: "assistant",
    content: text.join("") || null,
    tool_calls: toolCalls.length ? toolCalls : undefined
  });
}

function anthropicToolChoiceToOpenAI(toolChoice: NonNullable<AnthropicRequest["tool_choice"]>) {
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool" && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return undefined;
}

function openAIToolChoiceToAnthropic(toolChoice: NonNullable<OpenAIRequest["tool_choice"]>) {
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "required") return { type: "any" };
  if (typeof toolChoice === "object" && toolChoice.type === "function" && toolChoice.function?.name) {
    return { type: "tool", name: toolChoice.function.name };
  }
  return undefined;
}

function normalizeOpenAIStop(stop: OpenAIRequest["stop"]): string[] | undefined {
  if (Array.isArray(stop)) return stop;
  if (typeof stop === "string") return [stop];
  return undefined;
}

function finishReasonToAnthropic(reason: string | null | undefined): string {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "stop_sequence";
  return "end_turn";
}

function anthropicStopReasonToOpenAI(reason: string | null | undefined): string {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return "stop";
}

function parseJsonObject(value: string | undefined): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined)) as T;
}

function toolInputDelta(index: number, partialJson: string) {
  return {
    event: "content_block_delta",
    data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson } }
  };
}

function openAIChunk(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
