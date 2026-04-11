import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import type * as MsalTypes from "@azure/msal-node";

import {
  StaticAuthenticator,
  MsalAuthenticator,
} from "../src/auth.js";
import { AuthenticationRequiredError, UserCancelledError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// vi.mock must be at the top level (hoisted by vitest)
// ---------------------------------------------------------------------------

vi.mock("@azure/msal-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/msal-node")>();
  return {
    ...actual,
    PublicClientApplication: vi.fn(),
  };
});

// Lazy import so the mock is in place before we reference it.
let msal: typeof import("@azure/msal-node");

beforeEach(async () => {
  msal = await import("@azure/msal-node");
});

// ---------------------------------------------------------------------------
// Temp-dir helpers (same pattern as config.test.ts)
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function getTempDir(): string {
  const dir = path.join(os.tmpdir(), `graphdo-auth-test-${crypto.randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs
      .rm(dir, { recursive: true, force: true })
      .catch(() => {
        /* ignore cleanup errors */
      });
  }
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: build a fake PCA returned by the mocked constructor
// ---------------------------------------------------------------------------

interface FakePCA {
  acquireTokenInteractive: ReturnType<typeof vi.fn>;
  acquireTokenSilent: ReturnType<typeof vi.fn>;
}

function installFakePCA(): FakePCA {
  const fakePCA: FakePCA = {
    acquireTokenInteractive: vi.fn(),
    acquireTokenSilent: vi.fn(),
  };

  // Must use a regular function (not arrow) so it can be called with `new`
  const ctor = vi.mocked(msal.PublicClientApplication);
  ctor.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, fakePCA);
  } as never);

  return fakePCA;
}

// Helper to build a minimal AuthenticationResult
function authResult(
  overrides: Partial<MsalTypes.AuthenticationResult> = {},
): MsalTypes.AuthenticationResult {
  return {
    authority: "https://login.microsoftonline.com/common",
    uniqueId: "uid-1",
    tenantId: "tid-1",
    scopes: ["User.Read"],
    account: {
      homeAccountId: "home-1",
      environment: "login.microsoftonline.com",
      tenantId: "tid-1",
      username: "user@example.com",
      localAccountId: "local-1",
    },
    idToken: "id-token",
    idTokenClaims: {},
    accessToken: "access-token-123",
    fromCache: false,
    expiresOn: new Date(Date.now() + 3600 * 1000),
    tokenType: "Bearer",
    correlationId: "corr-1",
    ...overrides,
  };
}

// =========================================================================
// StaticAuthenticator
// =========================================================================

describe("StaticAuthenticator", () => {
  it("login resolves with a static message", async () => {
    const auth = new StaticAuthenticator("my-token");
    const result = await auth.login();
    expect(result.message).toMatch(/static token/i);
  });

  it("token returns the fixed access token", async () => {
    const auth = new StaticAuthenticator("fixed-token");
    const token = await auth.token();
    expect(token).toBe("fixed-token");
  });

  it("logout is a no-op (does not throw)", async () => {
    const auth = new StaticAuthenticator("t");
    await expect(auth.logout()).resolves.toBeUndefined();
  });

  it("isAuthenticated always returns true", async () => {
    const auth = new StaticAuthenticator("t");
    expect(await auth.isAuthenticated()).toBe(true);
  });

  it("accountInfo returns username 'static-token'", async () => {
    const auth = new StaticAuthenticator("t");
    const info = await auth.accountInfo();
    expect(info).toEqual({ username: "static-token" });
  });
});

// =========================================================================
// MsalAuthenticator — login
// =========================================================================

describe("MsalAuthenticator.login", () => {
  it("completes via browser login when interactive succeeds", async () => {
    const dir = getTempDir();
    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    const fakePCA = installFakePCA();
    fakePCA.acquireTokenInteractive.mockResolvedValue(authResult());

    const result = await auth.login();

    expect(result.message).toContain("user@example.com");
    // Account file should be saved
    const accountPath = path.join(dir, "account.json");
    const raw = await fs.readFile(accountPath, "utf-8");
    const parsed = JSON.parse(raw) as { username: string };
    expect(parsed.username).toBe("user@example.com");
  });

  it("throws when browser login fails (no device code fallback)", async () => {
    const dir = getTempDir();
    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    const fakePCA = installFakePCA();
    // Browser login fails
    fakePCA.acquireTokenInteractive.mockRejectedValue(
      new Error("cannot open browser"),
    );

    await expect(auth.login()).rejects.toThrow("cannot open browser");
  });

  it("saves the account file with mode 0o600", async () => {
    const dir = getTempDir();
    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    const fakePCA = installFakePCA();
    fakePCA.acquireTokenInteractive.mockResolvedValue(authResult());

    await auth.login();

    const accountPath = path.join(dir, "account.json");
    const stat = await fs.stat(accountPath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// =========================================================================
// MsalAuthenticator — token
// =========================================================================

describe("MsalAuthenticator.token", () => {
  it("returns access token when silent acquisition succeeds", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    // Write a valid account file so loadAccount succeeds
    await fs.writeFile(
      path.join(dir, "account.json"),
      JSON.stringify({
        homeAccountId: "home-1",
        environment: "login.microsoftonline.com",
        tenantId: "tid-1",
        username: "user@example.com",
        localAccountId: "local-1",
      }),
    );

    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    const fakePCA = installFakePCA();
    fakePCA.acquireTokenSilent.mockResolvedValue(
      authResult({ accessToken: "silent-token-xyz" }),
    );

    const token = await auth.token();
    expect(token).toBe("silent-token-xyz");
  });

  it("throws AuthenticationRequiredError when no account file exists", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });

    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    installFakePCA();

    await expect(auth.token()).rejects.toThrow(AuthenticationRequiredError);
  });

  it("throws AuthenticationRequiredError on InteractionRequiredAuthError", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "account.json"),
      JSON.stringify({
        homeAccountId: "home-1",
        environment: "login.microsoftonline.com",
        tenantId: "tid-1",
        username: "user@example.com",
        localAccountId: "local-1",
      }),
    );

    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    const fakePCA = installFakePCA();
    fakePCA.acquireTokenSilent.mockRejectedValue(
      new msal.InteractionRequiredAuthError("interaction_required"),
    );

    await expect(auth.token()).rejects.toThrow(AuthenticationRequiredError);
  });

  it("re-throws non-InteractionRequired errors from silent acquisition", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "account.json"),
      JSON.stringify({
        homeAccountId: "home-1",
        environment: "login.microsoftonline.com",
        tenantId: "tid-1",
        username: "user@example.com",
        localAccountId: "local-1",
      }),
    );

    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    const fakePCA = installFakePCA();
    fakePCA.acquireTokenSilent.mockRejectedValue(new Error("network failure"));

    await expect(auth.token()).rejects.toThrow("network failure");
  });
});

// =========================================================================
// MsalAuthenticator — logout
// =========================================================================

/** Helper: openBrowser mock that auto-POSTs to a given path after a short delay. */
function makeBrowserSpy(
  path: string,
): ReturnType<typeof vi.fn<(url: string) => Promise<void>>> {
  return vi.fn((url: string) => {
    setTimeout(() => {
      void fetch(`${url}${path}`, { method: "POST" }).catch(() => { /* fire and forget */ });
    }, 30);
    return Promise.resolve();
  });
}

describe("MsalAuthenticator.logout", () => {
  it("clears cache files when user confirms", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "msal_cache.json"), "{}");
    await fs.writeFile(path.join(dir, "account.json"), "{}");

    const openBrowser = makeBrowserSpy("/confirm");
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    await auth.logout();

    await expect(fs.access(path.join(dir, "msal_cache.json"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "account.json"))).rejects.toThrow();
  });

  it("throws UserCancelledError when user cancels", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "msal_cache.json"), "{}");
    await fs.writeFile(path.join(dir, "account.json"), "{}");

    const openBrowser = makeBrowserSpy("/cancel");
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    await expect(auth.logout()).rejects.toThrow(UserCancelledError);

    // Files should NOT be deleted when cancelled
    await expect(fs.access(path.join(dir, "msal_cache.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "account.json"))).resolves.toBeUndefined();
  });

  it("clears tokens silently when browser cannot be opened", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "msal_cache.json"), "{}");
    await fs.writeFile(path.join(dir, "account.json"), "{}");

    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockRejectedValue(
      new Error("no browser available"),
    );
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    await auth.logout();

    await expect(fs.access(path.join(dir, "msal_cache.json"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "account.json"))).rejects.toThrow();
  });

  it("does not throw when cache files do not exist (ENOENT ignored)", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    // No cache files exist

    const openBrowser = makeBrowserSpy("/confirm");
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    await expect(auth.logout()).resolves.toBeUndefined();
  });

  it("still clears the remaining file when only one cache file exists", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "account.json"), "{}");
    // msal_cache.json does NOT exist

    const openBrowser = makeBrowserSpy("/confirm");
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    await auth.logout();

    await expect(fs.access(path.join(dir, "account.json"))).rejects.toThrow();
  });
});

// =========================================================================
// MsalAuthenticator — isAuthenticated
// =========================================================================

describe("MsalAuthenticator.isAuthenticated", () => {
  it("returns true when token() succeeds", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "account.json"),
      JSON.stringify({
        homeAccountId: "home-1",
        environment: "login.microsoftonline.com",
        tenantId: "tid-1",
        username: "user@example.com",
        localAccountId: "local-1",
      }),
    );

    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    const fakePCA = installFakePCA();
    fakePCA.acquireTokenSilent.mockResolvedValue(authResult());

    expect(await auth.isAuthenticated()).toBe(true);
  });

  it("returns false when no account file exists", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });

    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    installFakePCA();

    expect(await auth.isAuthenticated()).toBe(false);
  });

  it("returns false when silent acquisition fails", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "account.json"),
      JSON.stringify({
        homeAccountId: "home-1",
        environment: "login.microsoftonline.com",
        tenantId: "tid-1",
        username: "user@example.com",
        localAccountId: "local-1",
      }),
    );

    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    const fakePCA = installFakePCA();
    fakePCA.acquireTokenSilent.mockRejectedValue(new Error("expired"));

    expect(await auth.isAuthenticated()).toBe(false);
  });
});

// =========================================================================
// MsalAuthenticator — accountInfo
// =========================================================================

describe("MsalAuthenticator.accountInfo", () => {
  it("returns username from saved account file", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "account.json"),
      JSON.stringify({
        homeAccountId: "home-1",
        environment: "login.microsoftonline.com",
        tenantId: "tid-1",
        username: "alice@example.com",
        localAccountId: "local-1",
      }),
    );

    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    const info = await auth.accountInfo();
    expect(info).toEqual({ username: "alice@example.com" });
  });

  it("returns null when no account file exists", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });

    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    const info = await auth.accountInfo();
    expect(info).toBeNull();
  });

  it("returns null when account file contains invalid JSON", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "account.json"), "not-json{{{");

    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    const info = await auth.accountInfo();
    expect(info).toBeNull();
  });

  it("returns null when account file fails schema validation", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    // Valid JSON but missing required 'username' field
    await fs.writeFile(
      path.join(dir, "account.json"),
      JSON.stringify({ homeAccountId: "h-1" }),
    );

    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, ["User.Read"], openBrowser);

    const info = await auth.accountInfo();
    expect(info).toBeNull();
  });
});
