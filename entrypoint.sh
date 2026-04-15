#!/usr/bin/env bash
set -euo pipefail

# Fix ownership on the data directory — Railway volume mounts are root-owned
# but the app runs as the unprivileged `node` user.
chown -R node:node /app/data 2>/dev/null || true

PORT="${PORT:-8000}"
MCP_TRANSPORT="${MCP_TRANSPORT:-streamableHttp}"
XERO_REFRESH_TOKEN="${XERO_REFRESH_TOKEN:-}"
XERO_CLIENT_ID="${XERO_CLIENT_ID:-}"
XERO_CLIENT_SECRET="${XERO_CLIENT_SECRET:-}"

# ── Node.js supervisor path ───────────────────────────────────────────────────
# When a refresh token is available (either from env or persisted on volume),
# delegate to the Node.js supervisor which keeps the Xero access token alive
# by proactively refreshing it every ~25 min.

HAS_PERSISTED_TOKEN=""
if [[ -s /app/data/refresh_token ]]; then
  HAS_PERSISTED_TOKEN="1"
fi

if [[ (-n "$XERO_REFRESH_TOKEN" || -n "$HAS_PERSISTED_TOKEN") && -n "$XERO_CLIENT_ID" && -n "$XERO_CLIENT_SECRET" ]]; then
  exec su -s /bin/sh node -c 'exec node /app/entrypoint.mjs'
fi

# ── Direct supergateway path ─────────────────────────────────────────────────
# No refresh token — launch supergateway directly (access token or
# client-credentials grant handled by @xeroapi/xero-mcp-server itself).

echo "==> Starting Xero MCP server on port ${PORT} (transport: ${MCP_TRANSPORT})"
exec su -s /bin/sh node -c "exec supergateway --stdio 'npx -y @xeroapi/xero-mcp-server' --port $PORT --outputTransport $MCP_TRANSPORT --healthEndpoint /"
