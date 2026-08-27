import { useEffect, useRef, useState } from "react";
import type { AgentEvent, AppContext, TextMessage } from "@centia-io/agent-protocol";
import { streamChat } from "./stream.js";
import { MessageView } from "./MessageView.js";
import { LABELS, type UiAssistantMessage, type UiMessage } from "./types.js";

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

export type AgentChatProps = {
  endpoint: string;
  getToken: () => string | Promise<string>;
  getContext?: () => AppContext | undefined;
  onToolExecuted?: (toolName: string) => void;
  locale?: "da" | "en";
  initialMessages?: UiMessage[];
  onMessagesChange?: (messages: UiMessage[]) => void;
};

/** History for the wire: user text + assistant text (tool details stay in UI state). */
const toWire = (messages: UiMessage[]): TextMessage[] =>
  messages
    .map((m): TextMessage => ({ role: m.role, content: m.text }))
    .filter((m) => m.content.trim().length > 0);

export function AgentChat(props: AgentChatProps) {
  const labels = LABELS[props.locale ?? "da"];
  const [messages, setMessages] = useState<UiMessage[]>(props.initialMessages ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    props.onMessagesChange?.(messages);
  }, [messages]);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight });
  }, [messages, busy]);

  /** Run one server request (fresh turn or resume) and stream into a draft. */
  const run = async (
    history: TextMessage[],
    resumePayload: import("@centia-io/agent-protocol").ResumePayload | undefined,
    assistantId: string,
  ) => {
    setBusy(true);
    setError(null);
    const toolNamesById = new Map<string, string>();
    try {
      const token = await props.getToken();
      await streamChat({
        endpoint: props.endpoint,
        token,
        body: { messages: history, context: props.getContext?.(), resume: resumePayload },
        onEvent: (ev: AgentEvent) => {
          setMessages((cur) =>
            cur.map((m) => {
              if (m.id !== assistantId || m.role !== "assistant") return m;
              const next: UiAssistantMessage = {
                ...m,
                toolCalls: m.toolCalls.map((c) => ({ ...c })),
              };
              if (ev.type === "text") {
                next.text = next.text ? `${next.text}\n\n${ev.text}` : ev.text;
              } else if (ev.type === "tool_use") {
                toolNamesById.set(ev.id, ev.name);
                if (!next.toolCalls.some((c) => c.id === ev.id)) {
                  next.toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
                }
              } else if (ev.type === "tool_result") {
                const call = next.toolCalls.find((c) => c.id === ev.toolUseId);
                if (call) {
                  call.result = ev.content;
                  call.isError = ev.isError;
                }
                const name = toolNamesById.get(ev.toolUseId) ?? call?.name;
                if (name && !ev.isError) props.onToolExecuted?.(name);
              } else if (ev.type === "confirm_request") {
                next.confirm = {
                  pending: ev.pending,
                  snapshot: ev.snapshot,
                  decisions: {},
                  resolved: false,
                };
                for (const p of ev.pending) toolNamesById.set(p.id, p.name);
                for (const p of ev.pending) {
                  if (!next.toolCalls.some((c) => c.id === p.id)) {
                    next.toolCalls.push({ id: p.id, name: p.name, input: p.input });
                  }
                }
              } else if (ev.type === "done") {
                if (ev.truncated) {
                  next.text = next.text ? `${next.text}\n\n_${labels.truncated}_` : `_${labels.truncated}_`;
                }
              } else if (ev.type === "error") {
                setError(ev.error);
              }
              return next;
            }),
          );
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    const userMsg: UiMessage = { id: newId(), role: "user", text };
    const assistantId = newId();
    const history = [...messagesRef.current, userMsg];
    setMessages([
      ...history,
      { id: assistantId, role: "assistant", text: "", toolCalls: [] },
    ]);
    setInput("");
    await run(toWire(history), undefined, assistantId);
  };

  /** Record a decision; when all writes are decided, send the resume request. */
  const decide = (messageId: string, toolUseId: string, approved: boolean) => {
    const msg = messagesRef.current.find(
      (m): m is UiAssistantMessage => m.id === messageId && m.role === "assistant",
    );
    const confirm = msg?.confirm;
    if (!msg || !confirm || confirm.resolved) return;
    const decisions = { ...confirm.decisions, [toolUseId]: approved };
    const writes = confirm.pending.filter((p) => p.requiresApproval);
    const complete = writes.every((p) => decisions[p.id] !== undefined);
    setMessages((cur) =>
      cur.map((m) =>
        m.id === messageId && m.role === "assistant"
          ? { ...m, confirm: { ...confirm, decisions, resolved: complete } }
          : m,
      ),
    );
    if (!complete) return;
    void run(
      toWire(messagesRef.current.filter((m) => m.id !== messageId || m.role !== "assistant")),
      {
        snapshot: confirm.snapshot,
        pending: confirm.pending,
        decisions: writes.map((p) => ({ toolUseId: p.id, approved: decisions[p.id] === true })),
      },
      messageId,
    );
  };

  return (
    <div className="ca-root">
      <div className="ca-scroll" ref={scrollerRef}>
        {messages.length === 0 && (
          <div className="ca-empty">
            <div className="ca-empty-title">{labels.emptyTitle}</div>
            <div className="ca-empty-body">{labels.emptyBody}</div>
          </div>
        )}
        {messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            labels={labels}
            onDecide={(toolUseId, approved) => decide(m.id, toolUseId, approved)}
          />
        ))}
        {busy && <div className="ca-thinking">{labels.thinking}</div>}
        {error && <div className="ca-error">{error}</div>}
      </div>
      <form
        className="ca-inputrow"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          className="ca-input"
          rows={2}
          value={input}
          disabled={busy}
          placeholder={labels.placeholder}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <button className="ca-btn ca-btn-send" type="submit" disabled={busy || !input.trim()}>
          {labels.send}
        </button>
      </form>
    </div>
  );
}
