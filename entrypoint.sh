#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
MCP_TRANSPORT="${MCP_TRANSPORT:-streamableHttp}"
MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-}"
XERO_REFRESH_TOKEN="${XERO_REFRESH_TOKEN:-}"
XERO_CLIENT_ID="${XERO_CLIENT_ID:-}"
XERO_CLIENT_SECRET="${XERO_CLIENT_SECRET:-}"

# ── Refresh-token path → Node.js supervisor ──────────────────────────────────
# Xero access tokens expire after ~30 minutes. When a refresh token is
# available, delegate to the Node.js supervisor which keeps the token alive
# by proactively refreshing it every ~25 minutes and restarting supergateway.

if [[ -n "$XERO_REFRESH_TOKEN" && -n "$XERO_CLIENT_ID" && -n "$XERO_CLIENT_SECRET" ]]; then
  exec node /app/entrypoint.mjs
fi

# ── Static-token / Custom Connection path ────────────────────────────────────
# No refresh token — launch supergateway directly (access token or
# client-credentials grant handled by @xeroapi/xero-mcp-server itself).

args=(
  --stdio "npx -y @xeroapi/xero-mcp-server"
  --port "$PORT"
  --outputTransport "$MCP_TRANSPORT"
  --healthEndpoint /
)

if [[ -n "$MCP_BEARER_TOKEN" ]]; then
  args+=(--header "Authorization: Bearer $MCP_BEARER_TOKEN")
fi

echo "==> Starting Xero MCP server on port ${PORT} (transport: ${MCP_TRANSPORT})"
exec supergateway "${args[@]}"
