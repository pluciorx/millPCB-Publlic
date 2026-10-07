# millPCB MCP server — Streamable HTTP MCP (/mcp) + live preview/SSE.
# Build:  docker build -t millpcb-mcp .
# Run:    see docker-compose.yml (Portainer stack on the LAN).
FROM node:24-alpine

WORKDIR /app

# Static app (preview assets + DOM-free kernel)
COPY index.html help.html ./
COPY css css
COPY js js
COPY libs libs
COPY img img

# MCP module with pinned dependencies
COPY mcp/package.json mcp/package-lock.json mcp/
RUN npm ci --omit=dev --prefix mcp
COPY mcp/*.mjs mcp/

# Runtime defaults — all overridable via environment / compose.
ENV MILLPCB_TRANSPORT=http \
    MILLPCB_BIND=0.0.0.0 \
    MILLPCB_ROOT=/app \
    MILLPCB_MCP_PORT=8090 \
    MILLPCB_PREVIEW_PORT=7847 \
    MILLPCB_PROJECTS_DIR=/data/projects \
    MILLPCB_EXPORTS_DIR=/data/exports \
    MILLPCB_RESTORE=1

RUN mkdir -p /data/projects /data/exports && chown -R node:node /app /data

USER node

# 8090 = MCP Streamable HTTP endpoint (/mcp), 7847 = live preview + SSE
EXPOSE 8090 7847

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:7847/api/health || exit 1

ENTRYPOINT ["node", "mcp/server.mjs"]
