#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
MCP_TRANSPORT="${MCP_TRANSPORT:-streamableHttp}"
MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-}"
XERO_REFRESH_TOKEN="${XERO_REFRESH_TOKEN:-}"
XERO_CLIENT_ID="${XERO_CLIENT_ID:-}"
XERO_CLIENT_SECRET="${XERO_CLIENT_SECRET:-}"

# ── Token refresh ────────────────────────────────────────────────────────────
# If a refresh token is provided (from the OAuth2 auth-code flow), exchange it
# for a fresh access token on every startup. This avoids needing Custom
# Connections (paid) or manually rotating 30-min access tokens.

if [[ -n "$XERO_REFRESH_TOKEN" && -n "$XERO_CLIENT_ID" && -n "$XERO_CLIENT_SECRET" ]]; then
  echo "==> Refreshing Xero access token..."

  credentials=$(printf '%s:%s' "$XERO_CLIENT_ID" "$XERO_CLIENT_SECRET" | base64 -w0 2>/dev/null || printf '%s:%s' "$XERO_CLIENT_ID" "$XERO_CLIENT_SECRET" | base64)

  token_response=$(curl -sf -X POST "https://identity.xero.com/connect/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -H "Authorization: Basic ${credentials}" \
    -d "grant_type=refresh_token&refresh_token=${XERO_REFRESH_TOKEN}")

  access_token=$(echo "$token_response" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      const t=JSON.parse(d);
      if(t.error){console.error('Token error:',t.error,t.error_description||'');process.exit(1)}
      process.stdout.write(t.access_token);
    })")

  export XERO_CLIENT_BEARER_TOKEN="$access_token"
  echo "==> Access token refreshed successfully"
fi

# ── Launch supergateway ──────────────────────────────────────────────────────

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
