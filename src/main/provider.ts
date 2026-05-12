export function providerChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/responses$/i.test(normalized)) return normalized.replace(/\/responses$/i, "/chat/completions");
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

export function providerMessagesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (/\/messages$/i.test(normalized)) return normalized;
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/messages`;
  return `${normalized}/v1/messages`;
}

export function providerResponsesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (/\/responses$/i.test(normalized)) return normalized;
  if (/\/chat\/completions$/i.test(normalized)) return normalized.replace(/\/chat\/completions$/i, "/responses");
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/responses`;
  return `${normalized}/v1/responses`;
}
