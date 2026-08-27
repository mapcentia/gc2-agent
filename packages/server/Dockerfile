FROM node:22-slim
RUN corepack enable && npm i -g @centia-io/mcp-server
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY packages/server ./packages/server
# pnpm >=11.2 blocks postinstall scripts (e.g. esbuild, a transitive dep of
# tsx) from an allowlist that is empty by default. The first install exits
# non-zero after reporting the ignored build; `approve-builds --all` then
# runs it non-interactively, and the final install is the real, verified one.
# --trust-lockfile bypasses pnpm's minimumReleaseAge/trustPolicy supply-chain
# check, which otherwise rejects lockfile entries published too recently
# relative to the build time. Appropriate here because this is a private,
# closed-source lockfile already reviewed in source control; drop the flag
# if/when this policy is pinned or relaxed via project-level pnpm config.
RUN (pnpm install --frozen-lockfile --trust-lockfile || true) \
    && pnpm approve-builds --all \
    && pnpm install --frozen-lockfile --trust-lockfile \
    && pnpm --filter @centia-io/agent-protocol build
ENV MCP_COMMAND=node \
    MCP_ARGS=/usr/local/lib/node_modules/@centia-io/mcp-server/dist/index.js \
    PORT=8790
EXPOSE 8790
WORKDIR /app/packages/server
CMD ["pnpm", "start"]
