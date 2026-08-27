# centia-agent

A chat agent that lets a Centia BaaS user talk to their own database and
schema through an LLM, using the Centia MCP server as the tool layer. Three
workspace packages:

- **`packages/protocol`** (`@centia-io/agent-protocol`) — shared TypeScript
  types for the chat wire protocol (`ChatRequest`, `AgentEvent`,
  `PendingToolRequest`, `ResumePayload`, …). No runtime dependencies; built
  with `tsc`.
- **`packages/server`** (`@centia-io/agent-server`) — a Hono HTTP server
  (`POST /api/chat`, `GET /api/health`) that drives the agent loop: it talks
  to an LLM provider (Bedrock, Anthropic, or an OpenAI-compatible endpoint),
  spawns a per-user Centia MCP stdio process, enforces tool guardrails, and
  streams newline-delimited JSON events back to the client.
- **`packages/ui`** (`@centia-io/agent-ui`) — a React chat component
  (`AgentChat`) plus an ndjson streaming client, for embedding the agent in a
  frontend app.

## Dev quickstart

```bash
pnpm install
cp packages/server/.env.example packages/server/.env   # then edit it
pnpm --filter @centia-io/agent-server dev
```

The server listens on `PORT` (default `8790`). Requests to `/api/chat`
require an `Authorization: Bearer <centia-token>` header — that token is the
caller's own Centia access token, obtained through the normal SDK OAuth flow
in the client app, not a server-side secret.

## Provider matrix

Selected by `LLM_PROVIDER` (default `bedrock`):

| `LLM_PROVIDER` | Required env                          | Optional env                                    |
| --------------- | -------------------------------------- | ------------------------------------------------ |
| `bedrock`       | `AWS_REGION`                           | `BEDROCK_MODEL` (default `anthropic.claude-opus-5`); AWS creds via the standard chain (env/profile/IAM role) |
| `anthropic`     | `ANTHROPIC_API_KEY`                    | `ANTHROPIC_MODEL` (default `claude-opus-5`)       |
| `openai`        | —                                       | `OPENAI_BASE_URL` (point at Ollama/LM Studio/vLLM), `OPENAI_MODEL` (default `gpt-5.1`) |

Also always required: `MCP_COMMAND` and `MCP_ARGS` (how to spawn the Centia
MCP server over stdio), and `API_BASE_URL` (the Centia API the MCP server
talks to, default `https://api.centia.io`).

## Confirmation protocol

1. The client POSTs `messages` (and optional `context`) to `/api/chat` with
   its Bearer token; the server streams ndjson `AgentEvent`s.
2. Read-class tool calls (`get*`, guarded `postSql` `SELECT`/`WITH`/`EXPLAIN`/`SHOW`)
   execute automatically within the turn.
3. A turn containing any write-class tool call (`post*`/`patch*`/`delete*`)
   executes nothing: the server emits a single `confirm_request` event with
   all pending calls and an opaque `snapshot`, and ends the stream with
   `stopReason: "awaiting_confirmation"`.
4. The UI shows the pending calls, collects per-call approve/deny decisions
   from the user, and re-POSTs with `resume: { snapshot, decisions }`.
5. The server re-derives every guardrail classification server-side (the
   client's flags are advisory only), executes only approved write calls,
   and continues the agent loop from the snapshot.

## Security model

- **No stored Centia credentials.** The only Centia credential in play is
  the caller's own Bearer token on each `/api/chat` request; it is never
  read from an env var and the server holds no service-level token.
- **One MCP process per token.** The server spawns and pools a Centia MCP
  stdio child process per distinct user token (keyed by its hash), injecting
  the token via `API_TOKEN` into that child's environment only. Idle
  sessions are reaped after 10 minutes.
- **Guardrail classes**, enforced server-side and re-checked on every
  resume:
  - `deny` — user/OAuth/client management and `postSqlNoToken` are never
    exposed to the model at all.
  - `write` — all other `post*`/`patch*`/`delete*` tools; require an
    explicit per-call user confirmation (see above) before execution.
  - `read` — `get*` tools and `postSql`, the latter only when the query is
    verified `SELECT`/`WITH`/`EXPLAIN`/`SHOW`; these auto-execute.
