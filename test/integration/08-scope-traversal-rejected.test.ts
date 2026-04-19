// Integration test #08: scope-traversal rejected (collab v1 §8.2 row 08).
//
// **Status: W2 Day 3 — `validateScopedPathSyntax` + `resolveScopedPath`.**
//
// W2 Day 3 implements the §4.6 scope-resolution algorithm in
// `src/collab/scope.ts`. The algorithm is the single primitive that
// gates every `path` argument across the forthcoming `collab_*` tools
// (W2 Day 4 onward). This file exercises it end-to-end against a mock
// Graph state so each row of §8.2 row 08 — one per refusal reason —
// has the same coverage shape that the eventual tool-layer integration
// will inherit.
//
// Per the §4.6 spec the pre-resolution refusals (steps 1–5) **must
// not** issue any Graph call. The "no Graph call" assertion uses the
// mock's `requestLog` (added in this milestone) and ignores the
// authentication-bootstrap requests `MockAuthenticator` performs at
// `createTestClient` time by snapshotting the log length before the
// resolver runs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { setupIntegrationEnv, teardownIntegrationEnv, type IntegrationEnv } from "./helpers.js";
import { resolveScopedPath } from "../../src/collab/scope.js";
import { OutOfScopeError } from "../../src/errors.js";
import { GraphClient } from "../../src/graph/client.js";
import type { TokenCredential } from "../../src/graph/client.js";
import { validateGraphId } from "../../src/graph/ids.js";
import { testSignal } from "../helpers.js";

const PROJECT_FOLDER_ID = "folder-proj";
const AUTHORITATIVE_FILE_ID = "file-spec";
const AUTHORITATIVE_FILE_NAME = "spec.md";
const PROJECT_DRIVE_ID = "mock-drive-1";

function staticToken(token: string): TokenCredential {
  return {
    getToken: (_signal: AbortSignal): Promise<string> => Promise.resolve(token),
  };
}

let env: IntegrationEnv;
let client: GraphClient;

function seedProject(): void {
  env.graphState.drive = {
    id: PROJECT_DRIVE_ID,
    driveType: "business",
    webUrl: "https://contoso-my.sharepoint.com/personal/user_contoso_com/Documents",
  };
  env.graphState.driveRootChildren = [
    {
      id: PROJECT_FOLDER_ID,
      name: "Project Foo",
      folder: {},
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
    },
  ];
  // Project root: spec.md (authoritative), proposals/, drafts/, attachments/
  env.graphState.driveFolderChildren.set(PROJECT_FOLDER_ID, [
    {
      id: AUTHORITATIVE_FILE_ID,
      name: AUTHORITATIVE_FILE_NAME,
      size: 12,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "text/markdown" },
      content: "# spec\n",
    },
    {
      id: "folder-proposals",
      name: "proposals",
      folder: { childCount: 1 },
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
    },
    {
      id: "folder-drafts",
      name: "drafts",
      folder: { childCount: 0 },
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
    },
    {
      id: "folder-attachments",
      name: "attachments",
      folder: { childCount: 1 },
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
    },
  ]);
  // proposals/foo.md (lowercase on disk — case-aliasing test agent path
  // is `proposals/Foo.md`, which OneDrive byPath resolves case-insensitively).
  env.graphState.driveFolderChildren.set("folder-proposals", [
    {
      id: "file-foo",
      name: "foo.md",
      size: 5,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "text/markdown" },
      content: "# foo\n",
    },
    // A shortcut/redirect masquerading as `proposals/redirect.md`.
    {
      id: "file-redirect",
      name: "redirect.md",
      size: 0,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "text/markdown" },
      remoteItem: { id: "remote-target", driveId: "evil-drive" },
    },
    // A cross-drive item: parentReference.driveId differs from the pin.
    {
      id: "file-crossdrive",
      name: "crossdrive.md",
      size: 0,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "text/markdown" },
      parentReference: { id: "folder-proposals", driveId: "other-drive" },
    },
  ]);
  // attachments/sub/sub2/img.png — recursive depth allowed.
  env.graphState.driveFolderChildren.set("folder-attachments", [
    {
      id: "folder-attachments-sub",
      name: "sub",
      folder: { childCount: 1 },
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
    },
  ]);
  env.graphState.driveFolderChildren.set("folder-attachments-sub", [
    {
      id: "folder-attachments-sub2",
      name: "sub2",
      folder: { childCount: 1 },
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
    },
  ]);
  env.graphState.driveFolderChildren.set("folder-attachments-sub2", [
    {
      id: "file-img",
      name: "img.png",
      size: 7,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "image/png" },
      content: "\u0089PNG...",
    },
  ]);
}

const RESOLVER_ARGS = {
  projectFolderId: validateGraphId("projectFolderId", PROJECT_FOLDER_ID),
  driveId: PROJECT_DRIVE_ID,
  authoritativeFileName: AUTHORITATIVE_FILE_NAME,
};

async function expectOutOfScope(
  inputPath: string,
  expectedReason: string,
): Promise<OutOfScopeError> {
  let caught: unknown;
  try {
    await resolveScopedPath(client, { ...RESOLVER_ARGS, path: inputPath }, testSignal());
  } catch (err) {
    caught = err;
  }
  if (!(caught instanceof OutOfScopeError)) {
    throw new Error(
      `Expected OutOfScopeError for ${JSON.stringify(inputPath)}, got ${String(caught)}`,
    );
  }
  expect(caught.reason).toBe(expectedReason);
  expect(caught.attemptedPath).toBe(inputPath);
  return caught;
}

function snapshotRequests(): { count: number } {
  return { count: env.graphState.requestLog.length };
}

function expectNoNewGraphCalls(snap: { count: number }): void {
  expect(env.graphState.requestLog.length).toBe(snap.count);
}

describe("08-scope-traversal-rejected", () => {
  beforeEach(async () => {
    env = await setupIntegrationEnv();
    seedProject();
    client = new GraphClient(env.graphUrl, staticToken("integration-token"));
  });

  afterEach(async () => {
    await teardownIntegrationEnv(env);
  });

  // -------------------------------------------------------------------------
  // Pre-resolution refusals (§4.6 steps 1–5) — MUST issue zero Graph calls.
  // -------------------------------------------------------------------------

  describe("pre-resolution refusals issue zero Graph calls", () => {
    const rows: { name: string; path: string; reason: string }[] = [
      { name: "`..` traversal", path: "../foo.md", reason: "dotdot_segment" },
      { name: "encoded `..%2f` traversal", path: "..%2ffoo.md", reason: "dotdot_segment" },
      {
        name: "encoded `%2e%2e/` traversal",
        path: "%2e%2e/foo.md",
        reason: "dotdot_segment",
      },
      {
        name: "double-encoded `%252e%252e`",
        path: "%252e%252e/foo.md",
        reason: "double_encoded",
      },
      {
        name: "full-width `．．/` (homoglyph)",
        path: "．．/foo.md",
        reason: "homoglyph_or_compatibility_form",
      },
      { name: "leading `/`", path: "/proposals/foo.md", reason: "absolute_path" },
      { name: "drive-letter `C:/`", path: "C:/proposals/foo.md", reason: "drive_letter" },
      { name: "control char `\\u0001`", path: "foo\u0001.md", reason: "control_character" },
      {
        name: "dot-prefixed `.collab/foo`",
        path: ".collab/foo.md",
        reason: "dot_prefixed_segment",
      },
      {
        name: "unknown layout `random/foo.md`",
        path: "random/foo.md",
        reason: "path_layout_violation",
      },
      {
        name: "`proposals/foo.txt` (wrong extension)",
        path: "proposals/foo.txt",
        reason: "wrong_extension",
      },
      {
        name: "`proposals/sub/foo.md` (subfolder under flat group)",
        path: "proposals/sub/foo.md",
        reason: "subfolder_in_flat_group",
      },
    ];

    for (const row of rows) {
      it(`refuses ${row.name} → ${row.reason} (zero Graph calls)`, async () => {
        const before = snapshotRequests();
        await expectOutOfScope(row.path, row.reason);
        expectNoNewGraphCalls(before);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Post-resolution defence-in-depth (§4.6 step 7).
  // -------------------------------------------------------------------------

  describe("post-resolution defence-in-depth", () => {
    it("refuses a shortcut/redirect (`remoteItem` populated) → shortcut_redirect", async () => {
      const err = await expectOutOfScope("proposals/redirect.md", "shortcut_redirect");
      expect(err.resolvedItemId).toBe("file-redirect");
    });

    it("refuses a cross-drive item → cross_drive", async () => {
      const err = await expectOutOfScope("proposals/crossdrive.md", "cross_drive");
      expect(err.resolvedItemId).toBe("file-crossdrive");
    });

    it("refuses a case-aliased path (`proposals/Foo.md`) → case_aliasing", async () => {
      // OneDrive byPath resolution is case-insensitive — the mock returns
      // the on-disk `proposals/foo.md` even when the agent asks for
      // `Foo.md`. The §4.6 step 7 case-aliasing defence catches the
      // returned-name mismatch. (The top-level group `Proposals` would
      // refuse earlier at `path_layout_violation` because step 5 is
      // case-sensitive on the layout literals.)
      const err = await expectOutOfScope("proposals/Foo.md", "case_aliasing");
      expect(err.resolvedItemId).toBe("file-foo");
    });
  });

  // -------------------------------------------------------------------------
  // Allowed paths.
  // -------------------------------------------------------------------------

  describe("allowed paths resolve to a drive item", () => {
    it("accepts the pinned authoritative file at the root", async () => {
      const result = await resolveScopedPath(
        client,
        { ...RESOLVER_ARGS, path: AUTHORITATIVE_FILE_NAME },
        testSignal(),
      );
      expect(result.item.id).toBe(AUTHORITATIVE_FILE_ID);
      expect(result.syntax.kind).toBe("authoritative");
    });

    it("accepts a flat `proposals/foo.md`", async () => {
      const result = await resolveScopedPath(
        client,
        { ...RESOLVER_ARGS, path: "proposals/foo.md" },
        testSignal(),
      );
      expect(result.item.id).toBe("file-foo");
      expect(result.syntax.kind).toBe("proposals");
    });

    it("accepts `attachments/sub/sub2/img.png` (recursive group)", async () => {
      const result = await resolveScopedPath(
        client,
        { ...RESOLVER_ARGS, path: "attachments/sub/sub2/img.png" },
        testSignal(),
      );
      expect(result.item.id).toBe("file-img");
      expect(result.syntax.kind).toBe("attachments");
    });
  });

  // -------------------------------------------------------------------------
  // Downstream tool-layer rows land alongside `collab_read` (W2 Day 4).
  // -------------------------------------------------------------------------

  it.todo(
    "after `collab_read` lands (W2 Day 4): each refusal reason surfaces as an `OutOfScopeError` from the tool with a matching `scope_denied` audit entry",
  );
});
