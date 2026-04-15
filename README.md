# Xero MCP Server

A dedicated Docker image that hosts the
[@xeroapi/xero-mcp-server](https://github.com/XeroAPI/xero-mcp-server) as a
remote HTTP endpoint via [supergateway](https://github.com/supercorp-ai/supergateway).

Pre-installs the Xero MCP server at build time — eliminating cold-start latency
from runtime `npm install`.

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│  Container                                                    │
│                                                               │
│  @xeroapi/xero-mcp-server pre-installed at build time         │
│                                                               │
│  entrypoint.sh launches supergateway:                         │
│    supergateway --stdio "npx -y @xeroapi/xero-mcp-server"     │
│      --outputTransport streamableHttp                         │
│      --port $PORT                                             │
│                                                               │
│  Client ⇄ HTTP (Streamable HTTP) ⇄ stdio Xero MCP server     │
└──────────────────────────────────────────────────────────────┘
```

## Authentication

Three auth modes — pick one:

### Option 1: OAuth2 Authorization Code (free, recommended)

Standard OAuth2 flow via the browser. A helper script handles the redirect,
gets a **refresh token** (valid 60 days), and saves it to `.env`.

A Node.js supervisor (`entrypoint.mjs`) exchanges the refresh token for a
fresh access token on startup **and proactively re-refreshes every 25 minutes**
so the token never expires during a long-running session.

Xero uses **rotating refresh tokens** — each exchange invalidates the previous
token and issues a new one. The supervisor persists each rotated token to
`/app/data/refresh_token` on a Railway volume so it survives container restarts
and redeployments. On startup it reads the persisted token first, falling back
to the `XERO_REFRESH_TOKEN` env var on first boot.

1. Go to [Xero Developer → My Apps](https://developer.xero.com/app/manage/)
   and create a **Web App**.
2. Add `http://localhost:8233/callback` as a **Redirect URI**.
3. Copy the **Client ID** and **Client Secret** into `.env`.
4. Run the OAuth helper:

```bash
node scripts/oauth.mjs
```

Your browser opens, you log in to Xero and authorize the app, and the script
writes `XERO_REFRESH_TOKEN` into `.env`. That's it — start the container and
the supervisor keeps the access token alive automatically.

To re-authorize (e.g. after 60 days or to switch orgs), just run
`node scripts/oauth.mjs` again.

### Option 2: Custom Connection (paid Xero feature)

Uses the OAuth2 **client-credentials** grant — no browser flow needed. Requires
a [Custom Connection](https://developer.xero.com/documentation/guides/oauth2/custom-connections/)
on your Xero app, which is a paid feature. Set only `XERO_CLIENT_ID` +
`XERO_CLIENT_SECRET` (no refresh token).

### Option 3: Bearer Token (manual)

If you already have a Xero access token, set `XERO_CLIENT_BEARER_TOKEN`
directly. Takes precedence over everything else. Tokens expire in ~30 minutes,
so this is only practical for quick one-off testing.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `XERO_CLIENT_ID` | Yes* | — | Xero app client ID |
| `XERO_CLIENT_SECRET` | Yes* | — | Xero app client secret |
| `XERO_REFRESH_TOKEN` | No | — | OAuth2 refresh token (written by `scripts/oauth.mjs`) |
| `XERO_CLIENT_BEARER_TOKEN` | No | — | Pre-obtained access token (takes precedence over everything) |
| `PORT` | No | `8000` | Port supergateway listens on |
| `MCP_TRANSPORT` | No | `streamableHttp` | Output transport: `streamableHttp` or `sse` |

\* Required for Options 1 and 2. Not needed if using `XERO_CLIENT_BEARER_TOKEN` (Option 3).

## Run locally

```bash
cp .env.example .env
# Add your XERO_CLIENT_ID and XERO_CLIENT_SECRET

node scripts/oauth.mjs   # authorize via browser, saves refresh token to .env

docker compose -f docker-compose.local.yml up --build -d
curl http://localhost:8090/   # health check → "ok"
```

## Deploy to Railway

### Behind the auth gateway (recommended)

1. In your Railway project, add a new service and connect this repo.
2. Name it **`xero-mcp`** (the auth gateway derives the upstream hostname from
   the service name: `xero-mcp.railway.internal`).
3. Set env vars: `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REFRESH_TOKEN`.
4. **Pin the port**: set `PORT=8000` (must match the auth gateway's
   `INTERNAL_PORT`, which defaults to `8000`).
5. **Add a volume** mounted at `/app/data` (persists the rotated refresh token
   across redeployments).
6. **Do NOT add a public domain** — the auth gateway handles public access and
   authentication.
7. Deploy. The Xero MCP is now reachable at
   `https://<auth-gateway-domain>/xero/mcp`.

### Standalone

1. Create a new project on [Railway](https://railway.app) and connect this repo.
2. Run `node scripts/oauth.mjs` locally to get a refresh token.
3. Set `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, and `XERO_REFRESH_TOKEN` in the
   service's environment variables.
4. Add a volume at `/app/data` and set `PORT=8000`.
5. Add a public domain. Deploy.

## Connect a client

### Via auth gateway (OAuth 2.1)

```json
{
  "mcpServers": {
    "xero": {
      "url": "https://<auth-gateway-domain>/xero/mcp"
    }
  }
}
```

Claude/Cursor handle the OAuth flow automatically — DCR, browser login, token exchange.

### Direct (standalone only)

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "xero": {
      "url": "https://<your-domain>/mcp"
    }
  }
}
```

## Testing

```bash
docker compose -f docker-compose.test.yml up --build -d
sleep 5

curl http://localhost:8091/           # health check → "ok"

docker compose -f docker-compose.test.yml down
```

## Project structure

```
xero-mcp/
├── Dockerfile                  # Pre-installs @xeroapi/xero-mcp-server + supergateway
├── entrypoint.sh               # Shell entrypoint: volume permissions, delegates to supervisor
├── entrypoint.mjs              # Node.js supervisor: token refresh + persistence + child mgmt
├── entrypoint.test.mjs         # Tests for the supervisor
├── package.json                # Dev dependencies (vitest)
├── railway.toml                # Railway config (healthcheck, volume, restart policy)
├── docker-compose.local.yml    # Local dev stack
├── docker-compose.test.yml     # Test stack (dummy creds)
├── .env.example                # Env var template
├── .mcp.json                   # Cursor MCP client config
├── scripts/
│   └── oauth.mjs               # Browser-based OAuth2 flow, saves refresh token
└── test/
    └── smoke.sh                # Smoke test: build, health check, MCP initialize
```
