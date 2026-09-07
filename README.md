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
| `openai`        | `OPENAI_API_KEY` (required for the real OpenAI API; optional — any value — when `OPENAI_BASE_URL` points at a local OpenAI-compatible endpoint) | `OPENAI_BASE_URL` (point at Ollama/LM Studio/vLLM), `OPENAI_MODEL` (default `gpt-5.1`) |

The `openai` provider requires the endpoint to implement the OpenAI
**Responses API** with response storage enabled — `previous_response_id` is
used to link tool-result turns back to the prior turn. Plain Chat
Completions endpoints (e.g. Ollama today) are **not yet supported**; a Chat
Completions fallback is future work.

`MCP_ARGS` is always hard-required (how to invoke the Centia MCP server over
stdio); `MCP_COMMAND` defaults to `node` and `API_BASE_URL` defaults to
`https://api.centia.io` if unset. Recommend setting all three explicitly
rather than relying on the defaults.

The server also injects the MCP server package's `AGENTS.md` into the system
prompt and serves its `skills/*/SKILL.md` guides through a local `readSkill`
tool (a catalog of names + descriptions lives in the prompt; the model loads
guides on demand). The docs root is derived from `MCP_ARGS` (package root of
the invoked `dist/index.js`) and can be overridden with `MCP_DOCS_PATH`.
Requires `@centia-io/mcp-server` >= 1.0.17, which ships those files; missing
docs produce a boot warning and the agent runs without them.

## Docker / production

`Dockerfile` (workspace root) builds the server image; `docker-compose.yml`
is the Swarm stack used in production, mirroring gc2-chat: Traefik on the
shared `web` overlay → an nginx edge container → the agent server.

```bash
docker build -t mapcentia/gc2-agent:latest .        # from the workspace root
docker run --rm -p 8790:8790 -e AWS_REGION=eu-west-1 mapcentia/gc2-agent:latest
curl -s localhost:8790/api/health                    # {"ok":true,...}
```

Image properties:

- Runs as the non-root `node` user, under `tini` as PID 1 so `SIGTERM`
  reaches the server immediately (`node --import tsx src/index.ts`, no
  pnpm/tsx wrapper process in between).
- `HEALTHCHECK` polls `GET /api/health` every 30 s. It does not exercise
  the LLM credentials — a bad provider config shows up in the boot log, not
  in the health status.
- `@centia-io/mcp-server` is installed globally, pinned by the
  `MCP_SERVER_VERSION` build arg; `MCP_ARGS` already points at it.
- The pnpm version is pinned through `packageManager` in the root
  `package.json`, so the lockfile and the installer always match.
- There is no graceful shutdown in the server yet: in-flight chat streams
  are cut on redeploy, and pooled MCP children are reaped with the
  container rather than closed explicitly.

Deployment env is never baked in. Copy `.env.example` to `.env` and set at
least `AGENT_HOST`, the provider variables (`AWS_REGION` + `BEDROCK_MODEL`
plus either `AWS_BEARER_TOKEN_BEDROCK` or SigV4 credentials for `bedrock`,
or `ANTHROPIC_API_KEY` for `anthropic`) and `API_BASE_URL`. `docker stack
deploy` does not read `.env` on its own, so resolve it first:

```bash
docker compose build && docker compose push
docker stack deploy -c <(docker compose config) centia-agent
```

### Reverse-proxy contract

The host app calls the agent through relative URLs (`/agent/api/chat`), so
whatever fronts it must:

1. Route `/agent/*` on the host app's hostname to the agent and strip the
   `/agent` prefix (the server listens on `/api/*`).
2. Disable response buffering on that route — `/api/chat` streams ndjson
   events as they happen (the server also sends `X-Accel-Buffering: no`).
3. Allow long read timeouts; an agent turn can run for minutes.

`nginx/nginx.conf` implements exactly this and is what the compose stack
ships. Because the browser only ever talks to its own origin, the server's
wildcard `cors()` is not reachable cross-origin in this setup. **Do not
expose port 8790 directly to the internet** without first scoping CORS to
the host app's origin.

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
