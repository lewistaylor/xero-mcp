#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
MCP_TRANSPORT="${MCP_TRANSPORT:-streamableHttp}"
MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-}"
XERO_REFRESH_TOKEN="${XERO_REFRESH_TOKEN:-}"
XERO_CLIENT_ID="${XERO_CLIENT_ID:-}"
XERO_CLIENT_SECRET="${XERO_CLIENT_SECRET:-}"

# ── Node.js supervisor path ───────────────────────────────────────────────────
# Use the Node.js supervisor when:
#   - A refresh token is available (keeps Xero access token alive), OR
#   - MCP_BEARER_TOKEN is set (auth proxy protects the endpoint)

if [[ -n "$XERO_REFRESH_TOKEN" && -n "$XERO_CLIENT_ID" && -n "$XERO_CLIENT_SECRET" ]] || [[ -n "$MCP_BEARER_TOKEN" ]]; then
  exec node /app/entrypoint.mjs
fi

# ── Direct supergateway path (no auth, no refresh) ───────────────────────────
# No refresh token and no bearer token — launch supergateway directly.
# WARNING: endpoint will be unprotected!

echo "==> WARNING: MCP_BEARER_TOKEN not set — endpoint is unprotected!"

args=(
  --stdio "npx -y @xeroapi/xero-mcp-server"
  --port "$PORT"
  --outputTransport "$MCP_TRANSPORT"
  --healthEndpoint /
)

echo "==> Starting Xero MCP server on port ${PORT} (transport: ${MCP_TRANSPORT})"
exec supergateway "${args[@]}"
