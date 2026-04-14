import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * We can't import entrypoint.mjs directly because it reads env vars at
 * module scope and registers signal handlers.  Instead we test the core
 * token-refresh logic by re-implementing the same HTTP call against a
 * mocked global.fetch, and verify the arg-building helper via a
 * dynamic import with controlled env.
 */

// ── refreshAccessToken ──────────────────────────────────────────────────────

describe("refreshAccessToken", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.XERO_CLIENT_ID = "test-client-id";
    process.env.XERO_CLIENT_SECRET = "test-client-secret";
    process.env.XERO_REFRESH_TOKEN = "original-refresh-token";
    delete process.env.XERO_CLIENT_BEARER_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("exchanges the refresh token for a new access token", async () => {
    const mockResponse = {
      access_token: "new-access-token-123",
      refresh_token: "rotated-refresh-token",
      expires_in: 1800,
      token_type: "Bearer",
    };

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const mod = await import("./entrypoint.mjs?" + Date.now());
    const token = await mod.refreshAccessToken();

    expect(token).toBe("new-access-token-123");
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://identity.xero.com/connect/token");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(opts.headers.Authorization).toMatch(/^Basic /);
    expect(opts.body).toContain("grant_type=refresh_token");
  });

  it("throws on non-OK HTTP responses", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad Request"),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const mod = await import("./entrypoint.mjs?" + Date.now() + 1);
    await expect(mod.refreshAccessToken()).rejects.toThrow(
      "Token refresh HTTP 400",
    );
  });

  it("throws on Xero error responses", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          error: "invalid_grant",
          error_description: "refresh token has expired",
        }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const mod = await import("./entrypoint.mjs?" + Date.now() + 2);
    await expect(mod.refreshAccessToken()).rejects.toThrow("invalid_grant");
  });

  it("uses rotating refresh tokens for successive calls", async () => {
    let callCount = 0;
    const fetchSpy = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: `access-${callCount}`,
            refresh_token: `refresh-${callCount}`,
            expires_in: 1800,
          }),
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const mod = await import("./entrypoint.mjs?" + Date.now() + 3);

    const first = await mod.refreshAccessToken();
    expect(first).toBe("access-1");

    const second = await mod.refreshAccessToken();
    expect(second).toBe("access-2");

    const secondBody = fetchSpy.mock.calls[1][1].body;
    expect(secondBody).toContain("refresh-1");
  });
});

// ── buildArgs ───────────────────────────────────────────────────────────────

describe("buildArgs", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.PORT = "9000";
    process.env.MCP_TRANSPORT = "sse";
    process.env.MCP_BEARER_TOKEN = "";
    process.env.XERO_CLIENT_ID = "id";
    process.env.XERO_CLIENT_SECRET = "secret";
    process.env.XERO_REFRESH_TOKEN = "rt";
    delete process.env.XERO_CLIENT_BEARER_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("includes port and transport from env", async () => {
    const mod = await import("./entrypoint.mjs?" + Date.now() + 10);
    const args = mod.buildArgs();

    expect(args).toContain("--port");
    expect(args).toContain("9000");
    expect(args).toContain("--outputTransport");
    expect(args).toContain("sse");
    expect(args).toContain("--healthEndpoint");
    expect(args).toContain("/");
  });

  it("includes MCP bearer auth header when set", async () => {
    process.env.MCP_BEARER_TOKEN = "secret-gateway-token";
    const mod = await import("./entrypoint.mjs?" + Date.now() + 11);
    const args = mod.buildArgs();

    expect(args).toContain("--header");
    expect(args).toContain("Authorization: Bearer secret-gateway-token");
  });
});

// ── REFRESH_INTERVAL_MS ─────────────────────────────────────────────────────

describe("REFRESH_INTERVAL_MS", () => {
  it("is 25 minutes", async () => {
    const mod = await import("./entrypoint.mjs?" + Date.now() + 20);
    expect(mod.REFRESH_INTERVAL_MS).toBe(25 * 60 * 1000);
  });
});
