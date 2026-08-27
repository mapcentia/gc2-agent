import { useState } from "react";
import type { UiToolCall } from "./types.js";

const preview = (value: unknown, max = 400): string => {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export function ToolCallView({ call }: { call: UiToolCall }) {
  const [open, setOpen] = useState(false);
  const status = call.result === undefined ? "…" : call.isError ? "✗" : "✓";
  return (
    <div className={`ca-tool ${call.isError ? "ca-tool-error" : ""}`}>
      <button type="button" className="ca-tool-head" onClick={() => setOpen(!open)}>
        <span className="ca-tool-status">{status}</span>
        <code>{call.name}</code>
      </button>
      {open && (
        <div className="ca-tool-body">
          <pre>{preview(call.input)}</pre>
          {call.result !== undefined && <pre>{preview(call.result, 2000)}</pre>}
        </div>
      )}
    </div>
  );
}
