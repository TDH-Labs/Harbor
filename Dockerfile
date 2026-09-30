# Harbor Server — authenticated HTTP MCP for many tenants (`harbor serve`).
#
#   docker build -t harbor-tugboat .
#   docker run -d --name harbor -p 127.0.0.1:8787:8787 -v harbor-data:/data harbor-tugboat
#   docker exec harbor bun src/cli.ts tenant create acme        # then tokens, skills…
#
# The image is the whole `harbor` CLI: `docker run … harbor-tugboat tenant list`
# works too (the entrypoint is the CLI; the default command is `serve`).
#
# Runs as the unprivileged `bun` user. /data must be writable by uid 1000; when
# bind-mounting a host directory, `chown 1000:1000` it (a named volume is fine).
#
# TLS is NOT terminated here: put a reverse proxy in front (see docs/CLOUD.md and
# deploy/Caddyfile.example). Tokens travel in the clear otherwise.

FROM oven/bun:1.3-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim
ENV NODE_ENV=production \
    HARBOR_DATA_DIR=/data \
    HARBOR_HOST=0.0.0.0 \
    HARBOR_PORT=8787
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY integrations ./integrations
# Tests and test scaffolding are excluded by .dockerignore.
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME ["/data"]
EXPOSE 8787

# Liveness only: /healthz needs no auth and touches no tenant state.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.HARBOR_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["bun", "src/cli.ts"]
CMD ["serve"]
