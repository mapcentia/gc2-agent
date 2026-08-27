import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ToolCallView } from "./ToolCallView.js";
import { ConfirmCard } from "./ConfirmCard.js";
import type { Labels, UiMessage } from "./types.js";

export function MessageView({
  message,
  labels,
  onDecide,
}: {
  message: UiMessage;
  labels: Labels;
  onDecide: (toolUseId: string, approved: boolean) => void;
}) {
  if (message.role === "user") {
    return <div className="ca-msg ca-msg-user">{message.text}</div>;
  }
  return (
    <div className="ca-msg ca-msg-assistant">
      {message.toolCalls.map((c) => (
        <ToolCallView key={c.id} call={c} />
      ))}
      {message.text && (
        <div className="ca-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
        </div>
      )}
      {message.confirm && (
        <ConfirmCard confirm={message.confirm} labels={labels} onDecide={onDecide} />
      )}
    </div>
  );
}
