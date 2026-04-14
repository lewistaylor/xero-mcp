#!/usr/bin/env bash
# Smoke test for xero-mcp.
# Expects the test compose stack to be running on port 8091.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8091}"
PASS=0
FAIL=0

pass() { ((PASS++)); echo "  ✓ $1"; }
fail() { ((FAIL++)); echo "  ✗ $1: $2"; }

echo "==> Smoke testing xero-mcp at ${BASE_URL}"
echo

# ── Health check ─────────────────────────────────────────────────────────────
echo "Health check..."
status=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/")
if [[ "$status" == "200" ]]; then
  pass "GET / returned 200"
else
  fail "GET / returned ${status}" "expected 200"
fi

# ── MCP initialize ───────────────────────────────────────────────────────────
echo "MCP initialize..."
response=$(curl -s -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "smoke-test", "version": "1.0"}
    },
    "id": 1
  }' 2>&1)

if echo "$response" | grep -q '"serverInfo"'; then
  pass "POST /mcp initialize returned serverInfo"
elif echo "$response" | grep -q '"result"'; then
  pass "POST /mcp initialize returned a result"
else
  fail "POST /mcp initialize" "unexpected response: ${response:0:200}"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
