# syntax=docker/dockerfile:1
#
# centia-agent server image. Build from the workspace root:
#   docker build -t mapcentia/gc2-agent:latest .
#
# Runtime env is supplied by the deployment (see docker-compose.yml and
# .env.example) - no secrets are baked in here.

ARG NODE_IMAGE=node:22-slim
# Pinned so a rebuild is reproducible. Bump deliberately; >= 1.0.36 ships the
# core rules as the centia-rules skill (1.0.17+ works via the AGENTS.md fallback).
ARG MCP_SERVER_VERSION=1.0.36

###############################################################################
# Stage 1 - install workspace deps + build the protocol package
###############################################################################
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# pnpm version comes from the `packageManager` pin in package.json, so the
# lockfile and the installer always agree (no corepack-latest drift).
RUN corepack enable

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY packages/server ./packages/server

# esbuild (transitive dep of tsx) has a postinstall that pnpm 10 skips unless
# allowlisted; its native binary ships in @esbuild/linux-x64, so skipping the
# script is harmless. The "Ignored build scripts" warning is expected.
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @centia-io/agent-protocol build \
    && pnpm --filter @centia-io/agent-server typecheck

###############################################################################
# Stage 2 - runtime
###############################################################################
FROM ${NODE_IMAGE} AS runtime
ARG MCP_SERVER_VERSION
ENV NODE_ENV=production

# tini: PID 1 that forwards SIGTERM/SIGINT to node and reaps zombies. Node as
# PID 1 ignores SIGTERM (no default handler when PID 1), so without an init
# `docker stop` would wait for the 10s SIGKILL.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# The server spawns the Centia MCP server as a stdio child per user token, so
# it has to live in the image. Globally installed => stable path for MCP_ARGS.
RUN npm install -g @centia-io/mcp-server@${MCP_SERVER_VERSION} \
    && npm cache clean --force

# Copy the installed workspace (pnpm's node_modules are relative symlinks, so
# copying /app as a whole keeps them valid). Owned by the non-root `node`
# user that ships with the official image.
WORKDIR /app
COPY --from=build --chown=node:node /app /app

ENV MCP_COMMAND=node \
    MCP_ARGS=/usr/local/lib/node_modules/@centia-io/mcp-server/dist/index.js \
    PORT=8790
EXPOSE 8790

# Liveness: GET /api/health answers {"ok":true,...} once the server is up.
# LLM credentials are not exercised, so this stays green on a misconfigured
# provider - watch the boot log for that.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
WORKDIR /app/packages/server

# node runs the TS entry directly through tsx's loader - no pnpm/tsx wrapper
# process between tini and the server, so signals reach it immediately.
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
