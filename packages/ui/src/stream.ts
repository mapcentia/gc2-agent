import type { AgentEvent, ChatRequest } from "@centia-io/agent-protocol";

export const createNdjsonSplitter = (
  onLine: (line: string) => void,
): { push(chunk: string): void; flush(): void } => {
  let buffer = "";
  const emit = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed) onLine(trimmed);
  };
  return {
    push(chunk) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        emit(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },
    flush() {
      emit(buffer);
      buffer = "";
    },
  };
};

/**
 * POST the chat request and feed each NDJSON event to onEvent.
 * Pre-flight failures (4xx/5xx before the stream opens) throw an Error with
 * the server's message; once streaming, errors arrive as `error` events.
 */
export const streamChat = async (opts: {
  endpoint: string;
  token: string;
  body: ChatRequest;
  onEvent: (ev: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<void> => {
  const res = await fetch(opts.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* non-JSON body */
    }
    throw new Error(message);
  }
  const splitter = createNdjsonSplitter((line) => {
    try {
      opts.onEvent(JSON.parse(line) as AgentEvent);
    } catch {
      /* ignore malformed line */
    }
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    splitter.push(decoder.decode(value, { stream: true }));
  }
  splitter.push(decoder.decode());
  splitter.flush();
};
