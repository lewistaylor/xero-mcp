#!/usr/bin/env node

/**
 * Supervisor for the Xero MCP server that keeps the access token alive.
 *
 * Xero access tokens expire after ~30 minutes. When running the OAuth2
 * auth-code flow, this supervisor:
 *
 *   1. Exchanges the refresh token for a fresh access token on startup.
 *   2. Spawns supergateway with that token.
 *   3. Proactively refreshes the token every REFRESH_INTERVAL_MS (~25 min).
 *   4. Gracefully restarts supergateway with the new token so the
 *      downstream @xeroapi/xero-mcp-server picks it up.
 *
 * Xero uses rotating refresh tokens — each exchange returns a new one.
 * The supervisor tracks the latest refresh token in memory so successive
 * refreshes keep working for the lifetime of the container.
 *
 * Authentication is handled externally by the mcp-auth-gateway service.
 * This service should only be reachable via Railway private networking.
 */

import { spawn } from "node:child_process";

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || "8000";
const MCP_TRANSPORT = process.env.MCP_TRANSPORT || "streamableHttp";
const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID || "";
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET || "";
const TOKEN_URL = "https://identity.xero.com/connect/token";

/** Refresh 5 minutes before the 30-minute expiry window. */
const REFRESH_INTERVAL_MS = 25 * 60 * 1000;

let refreshToken = process.env.XERO_REFRESH_TOKEN || "";
const canRefresh = !!(refreshToken && XERO_CLIENT_ID && XERO_CLIENT_SECRET);

// ── Token refresh ───────────────────────────────────────────────────────────

/**
 * Exchanges the current refresh token for a new access + refresh token pair.
 * Mutates `refreshToken` in place so the next call uses the rotated value.
 *
 * @returns The new access token string.
 * @throws  On network errors or if Xero returns an error response.
 */
async function refreshAccessToken() {
  const credentials = Buffer.from(
    `${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`,
  ).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(
      `Token error: ${data.error} ${data.error_description || ""}`,
    );
  }

  if (data.refresh_token) {
    refreshToken = data.refresh_token;
  }

  return data.access_token;
}

// ── Supergateway lifecycle ──────────────────────────────────────────────────

/** @type {import("node:child_process").ChildProcess | null} */
let gatewayProcess = null;
/** @type {ReturnType<typeof setInterval> | null} */
let refreshTimer = null;
let shuttingDown = false;

/**
 * Builds the argument list for the supergateway CLI.
 */
function buildArgs() {
  return [
    "--stdio",
    "npx -y @xeroapi/xero-mcp-server",
    "--port",
    PORT,
    "--outputTransport",
    MCP_TRANSPORT,
    "--healthEndpoint",
    "/",
  ];
}

/**
 * Spawns a new supergateway child process. Inherits stdio so logs flow
 * through to the container. Automatically restarts on unexpected exits
 * unless the supervisor is shutting down.
 *
 * @param {string} accessToken  Xero access token to inject into the child env.
 */
function startGateway(accessToken) {
  const env = { ...process.env };
  if (accessToken) {
    env.XERO_CLIENT_BEARER_TOKEN = accessToken;
  }

  const child = spawn("supergateway", buildArgs(), {
    env,
    stdio: "inherit",
  });

  child.on("error", (err) => {
    console.error(`[supervisor] supergateway spawn error: ${err.message}`);
    if (!shuttingDown) {
      setTimeout(() => startGateway(accessToken), 2000);
    }
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[supervisor] supergateway exited (code=${code}, signal=${signal}), restarting in 2s...`,
    );
    gatewayProcess = null;
    setTimeout(() => {
      if (!shuttingDown) startGateway(accessToken);
    }, 2000);
  });

  gatewayProcess = child;
}

/**
 * Kills the running supergateway and waits for it to exit (up to 5 s).
 */
async function stopGateway() {
  if (!gatewayProcess) return;

  const child = gatewayProcess;
  gatewayProcess = null;

  child.removeAllListeners("exit");
  child.kill("SIGTERM");

  await new Promise((resolve) => {
    child.on("exit", resolve);
    setTimeout(resolve, 5000);
  });
}

// ── Signal handling ─────────────────────────────────────────────────────────

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[supervisor] Received ${signal}, shutting down...`);

  if (refreshTimer) clearInterval(refreshTimer);

  if (gatewayProcess) {
    gatewayProcess.removeAllListeners("exit");
    gatewayProcess.kill(signal);
    gatewayProcess.on("exit", () => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let accessToken = process.env.XERO_CLIENT_BEARER_TOKEN || "";

  if (canRefresh) {
    console.log("[supervisor] Refreshing Xero access token...");
    accessToken = await refreshAccessToken();
    console.log("[supervisor] Access token refreshed successfully");

    refreshTimer = setInterval(async () => {
      try {
        console.log("[supervisor] Proactively refreshing Xero access token...");
        const newToken = await refreshAccessToken();
        console.log(
          "[supervisor] Token refreshed, restarting supergateway...",
        );
        await stopGateway();
        startGateway(newToken);
      } catch (err) {
        console.error(
          `[supervisor] Token refresh failed: ${err.message}`,
        );
        console.error(
          "[supervisor] Continuing with current token — will retry next interval",
        );
      }
    }, REFRESH_INTERVAL_MS);
  }

  console.log(
    `[supervisor] Starting Xero MCP server on port ${PORT} (transport: ${MCP_TRANSPORT})`,
  );
  startGateway(accessToken);
}

export {
  refreshAccessToken,
  buildArgs,
  startGateway,
  stopGateway,
  REFRESH_INTERVAL_MS,
};

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[supervisor] Fatal: ${err.message}`);
    process.exit(1);
  });
}
