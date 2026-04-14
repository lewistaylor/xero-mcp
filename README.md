# Xero MCP Server

A dedicated Docker image that hosts the
[@xeroapi/xero-mcp-server](https://github.com/XeroAPI/xero-mcp-server) as a
remote HTTP endpoint via [supergateway](https://github.com/supercorp-ai/supergateway).

Unlike the generic [mcp-gateway](https://github.com/dangerfarms/mcp-gateway),
this image **pre-installs** the Xero MCP server at build time — eliminating
cold-start latency from runtime `npm install`.

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
gets a **refresh token** (valid 60 days), and saves it to `.env`. The container
uses the refresh token to get a fresh access token on every startup.

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
the entrypoint exchanges the refresh token for a fresh access token
automatically.

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
| `MCP_BEARER_TOKEN` | No | — | Static bearer token to protect the gateway endpoint |

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

### Standalone

1. Create a new project on [Railway](https://railway.app) and connect this repo.
2. Run `node scripts/oauth.mjs` locally to get a refresh token.
3. Set `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, and `XERO_REFRESH_TOKEN` in the
   service's environment variables.
4. Deploy. The included `railway.toml` configures the build and healthcheck.

### Behind the mcp-gateway router

1. In your Railway project, add a new service and connect this repo.
2. Name it **`xero-mcp`** (the router derives the upstream hostname from the service name).
3. Set `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, and `XERO_REFRESH_TOKEN` as env vars.
4. **Do NOT add a public domain** — the router handles public access and authentication.
5. The Xero MCP is now reachable at `https://<router-domain>/xero/mcp`.

## Connect a client

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "xero": {
      "url": "https://mcp.dangerfarms.com/xero/mcp"
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "xero": {
      "command": "npx",
      "args": [
        "-y", "supergateway",
        "--streamableHttp", "https://mcp.dangerfarms.com/xero/mcp"
      ]
    }
  }
}
```

## Testing

Build and run the test stack:

```bash
docker compose -f docker-compose.test.yml up --build -d
sleep 5

# Health check
curl http://localhost:8091/
# → ok

# MCP initialize (will fail without valid Xero creds, but confirms the server is running)
curl -X POST http://localhost:8091/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'

docker compose -f docker-compose.test.yml down
```

## Project structure

```
xero-mcp/
├── Dockerfile                  # Pre-installs @xeroapi/xero-mcp-server + supergateway
├── entrypoint.sh               # Token refresh + launches supergateway
├── railway.toml                # Railway deployment config
├── docker-compose.local.yml    # Local dev stack
├── docker-compose.test.yml     # Test stack (dummy creds)
├── .env.example                # Env var template
├── .mcp.json                   # Cursor MCP client config
├── scripts/
│   └── oauth.mjs               # Browser-based OAuth2 flow, saves refresh token
└── test/
    └── smoke.sh                # Smoke test: build, health check, MCP initialize
```
