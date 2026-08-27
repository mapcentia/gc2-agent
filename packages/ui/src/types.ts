import type { PendingToolRequest } from "@centia-io/agent-protocol";

export type UiToolCall = {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
};

export type UiConfirm = {
  pending: PendingToolRequest[];
  snapshot: unknown;
  /** toolUseId -> approved; only requiresApproval entries appear here. */
  decisions: Record<string, boolean>;
  /** true once the resume request has been sent. */
  resolved: boolean;
};

export type UiUserMessage = { id: string; role: "user"; text: string };
export type UiAssistantMessage = {
  id: string;
  role: "assistant";
  text: string;
  toolCalls: UiToolCall[];
  confirm?: UiConfirm;
};
export type UiMessage = UiUserMessage | UiAssistantMessage;

export type Labels = {
  placeholder: string;
  send: string;
  thinking: string;
  approve: string;
  deny: string;
  approveAll: string;
  denyAll: string;
  confirmTitle: string;
  autoNote: string;
  truncated: string;
  emptyTitle: string;
  emptyBody: string;
};

export const LABELS: Record<"da" | "en", Labels> = {
  da: {
    placeholder: "Skriv en besked… (Enter sender, Shift+Enter ny linje)",
    send: "Send",
    thinking: "Tænker…",
    approve: "Godkend",
    deny: "Afvis",
    approveAll: "Godkend alle",
    denyAll: "Afvis alle",
    confirmTitle: "Agenten vil udføre følgende ændringer",
    autoNote: "Læse-kald udføres automatisk ved godkendelse.",
    truncated: "(Stoppede efter maks. iterationer — spørg igen for at fortsætte.)",
    emptyTitle: "Hvad kan jeg hjælpe med?",
    emptyBody:
      "Spørg om data, eller bed mig sætte skemaer, tabeller og kort-styling op. Ændringer udføres først, når du har godkendt dem.",
  },
  en: {
    placeholder: "Type a message… (Enter to send, Shift+Enter for newline)",
    send: "Send",
    thinking: "Thinking…",
    approve: "Approve",
    deny: "Deny",
    approveAll: "Approve all",
    denyAll: "Deny all",
    confirmTitle: "The agent wants to perform these changes",
    autoNote: "Read calls run automatically on approval.",
    truncated: "(Stopped after max iterations — ask again to continue.)",
    emptyTitle: "What can I help with?",
    emptyBody:
      "Ask about your data, or have me set up schemas, tables, and map styling. Changes only run after you approve them.",
  },
};
