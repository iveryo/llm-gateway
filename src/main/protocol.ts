import { GatewayConfig } from "../shared/types.js";

type AnthropicContentBlock =
  | { type: "text"; text: string }
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
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

export function anthropicToOpenAI(body: AnthropicRequest, config: GatewayConfig) {
  const anthropicModel = body.model ?? "";
  const mapping = config.modelMappings[anthropicModel];
  const providerId = mapping?.provider ?? config.defaultProvider;
  const providerModel = mapping?.model ?? config.defaultModel;
  const warning = anthropicModel && !mapping
    ? `No model mapping for ${anthropicModel}; used ${providerId}/${providerModel}`
    : undefined;

  const messages: OpenAIMessage[] = [];
  const system = normalizeSystem(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of body.messages ?? []) {
    messages.push(...convertAnthropicMessage(message));
  }

  const request: Record<string, unknown> = {
    model: providerModel,
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
    request.tool_choice = convertToolChoice(body.tool_choice);
  }

  return {
    anthropicModel,
    providerId,
    providerModel,
    warning,
    request: stripUndefined(request)
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

export function openAIStreamToAnthropicEvents(lines: string[], providerModel: string): unknown[] {
  const messageId = `msg_${crypto.randomUUID()}`;
  const events: unknown[] = [
    {
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
    }
  ];

  let textBlockOpen = false;
  let textIndex = 0;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string; index: number }>();
  let nextBlockIndex = 0;
  let stopReason: string | null = null;

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    const chunk = JSON.parse(payload);
    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? {};
    if (choice?.finish_reason) stopReason = finishReasonToAnthropic(choice.finish_reason);

    if (typeof delta.content === "string" && delta.content.length > 0) {
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
      usage: { output_tokens: 0 }
    }
  });
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return events;
}

export function openAIStreamToJson(lines: string[]) {
  const toolCalls = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
  let id = `chatcmpl_${crypto.randomUUID()}`;
  let model = "";
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

function openAIMessageToAnthropicContent(message: any): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
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

function convertToolChoice(toolChoice: NonNullable<AnthropicRequest["tool_choice"]>) {
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool" && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return undefined;
}

function finishReasonToAnthropic(reason: string | null | undefined): string {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "stop_sequence";
  return "end_turn";
}

function parseJsonObject(value: string): unknown {
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
