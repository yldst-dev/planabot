export type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
};

export function codexStream(text: string, options: { incomplete?: boolean; usage?: { input_tokens: number; output_tokens: number; }; } = {}): Response {
  const events = [
    { type: "response.created", response: { output: [] } },
    ...(text ? [{ type: "response.output_text.delta", delta: text }, { type: "response.output_text.done", text }] : []),
    {
      type: options.incomplete ? "response.incomplete" : "response.completed",
      response: { model: "gpt-6-astra", output: [], ...(options.usage ? { usage: options.usage } : {}) },
    },
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export function installFetch(
  handler: (request: CapturedRequest, index: number) => Response | Promise<Response>,
): { requests: CapturedRequest[]; codexRequests: () => CapturedRequest[]; restore: () => void; } {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = async (input, init) => {
    const raw = init?.body;
    const request: CapturedRequest = {
      url: String(input instanceof Request ? input.url : input),
      body: typeof raw === "string" && raw.trim().startsWith("{") ? JSON.parse(raw) as Record<string, unknown> : {},
      headers: new Headers(init?.headers),
    };
    requests.push(request);
    return handler(request, requests.length);
  };
  return {
    requests,
    codexRequests: () => requests.filter((request) => request.url.endsWith("/responses")),
    restore: () => { globalThis.fetch = original; },
  };
}

export function codexInputText(request: CapturedRequest): string {
  const input = Array.isArray(request.body.input) ? request.body.input as Array<{ content: unknown; }> : [];
  return [String(request.body.instructions ?? ""), ...input.map((item) => typeof item.content === "string" ? item.content : JSON.stringify(item.content))].join("\n");
}
