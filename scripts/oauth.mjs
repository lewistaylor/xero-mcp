#!/usr/bin/env node

/**
 * Interactive OAuth2 authorization-code flow for Xero.
 *
 * Reads XERO_CLIENT_ID and XERO_CLIENT_SECRET from .env (or the environment),
 * opens the browser to Xero's authorize page, catches the callback on a local
 * HTTP server, exchanges the code for tokens, and appends XERO_REFRESH_TOKEN
 * to .env.
 *
 * The refresh token is valid for 60 days. The container entrypoint uses it on
 * every startup to get a fresh 30-minute access token — no Custom Connection
 * (paid feature) required.
 *
 * Usage:
 *   node scripts/oauth.mjs            # reads from .env in cwd
 *   node scripts/oauth.mjs --port 9999 # use a different callback port
 *
 * Requirements:
 *   - Node.js 18+ (uses built-in fetch)
 *   - XERO_CLIENT_ID and XERO_CLIENT_SECRET set in .env or environment
 *   - Xero app redirect URI set to http://localhost:<port>/callback
 */

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";

const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.transactions",
  "accounting.contacts",
  "accounting.settings",
  "accounting.reports.read",
].join(" ");

// ── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let callbackPort = 8233;
const portIdx = args.indexOf("--port");
if (portIdx !== -1 && args[portIdx + 1]) {
  callbackPort = parseInt(args[portIdx + 1], 10);
}
const REDIRECT_URI = `http://localhost:${callbackPort}/callback`;

// ── Load .env ───────────────────────────────────────────────────────────────

const envPath = resolve(process.cwd(), ".env");

function loadDotenv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadDotenv(envPath);

const clientId = process.env.XERO_CLIENT_ID;
const clientSecret = process.env.XERO_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Error: XERO_CLIENT_ID and XERO_CLIENT_SECRET must be set in .env or environment.",
  );
  process.exit(1);
}

// ── PKCE ────────────────────────────────────────────────────────────────────

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const codeVerifier = base64url(randomBytes(32));
const codeChallenge = base64url(
  createHash("sha256").update(codeVerifier).digest(),
);
const state = randomBytes(16).toString("hex");

// ── Build authorize URL ─────────────────────────────────────────────────────

const authorizeParams = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  state,
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
});

const authorizeUrl = `${AUTHORIZE_URL}?${authorizeParams}`;

// ── Start callback server ───────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/callback")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const url = new URL(req.url, `http://localhost:${callbackPort}`);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
    shutdown(1);
    return;
  }

  if (returnedState !== state) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>State mismatch — possible CSRF attack</h1>");
    shutdown(1);
    return;
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>No authorization code received</h1>");
    shutdown(1);
    return;
  }

  try {
    const tokens = await exchangeCode(code);
    saveRefreshToken(tokens.refresh_token);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<h1>Authorized!</h1><p>You can close this tab. Check your terminal for next steps.</p>",
    );

    console.log("\nAuthorization successful!");
    console.log(`  Refresh token saved to ${envPath}`);
    console.log(`  Access token expires in ${tokens.expires_in}s\n`);
    console.log("Start the container:");
    console.log(
      "  docker compose -f docker-compose.local.yml up --build -d\n",
    );

    shutdown(0);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<h1>Token exchange failed</h1><pre>${err.message}</pre>`);
    console.error("Token exchange failed:", err);
    shutdown(1);
  }
});

server.listen(callbackPort, () => {
  console.log(`\nXero OAuth2 Authorization`);
  console.log(`─────────────────────────`);
  console.log(`Callback server listening on http://localhost:${callbackPort}`);
  console.log(`\nOpening browser to authorize with Xero...\n`);
  console.log(
    `If the browser doesn't open, visit this URL:\n  ${authorizeUrl}\n`,
  );
  openBrowser(authorizeUrl);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json();
}

function saveRefreshToken(refreshToken) {
  let envContent = "";
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, "utf-8");
  }

  const lines = envContent.split("\n");
  let replaced = false;
  const updated = lines.map((line) => {
    if (line.match(/^\s*#?\s*XERO_REFRESH_TOKEN\s*=/)) {
      replaced = true;
      return `XERO_REFRESH_TOKEN=${refreshToken}`;
    }
    return line;
  });

  if (!replaced) {
    updated.push("", `XERO_REFRESH_TOKEN=${refreshToken}`);
  }

  writeFileSync(envPath, updated.join("\n"));
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    execSync(`${cmd} "${url}"`, { stdio: "ignore" });
  } catch {
    // browser open is best-effort
  }
}

function shutdown(code) {
  server.close();
  setTimeout(() => process.exit(code), 300);
}
