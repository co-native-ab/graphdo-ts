// Shared helpers for markdown integration tests

import { type IntegrationEnv } from "../helpers.js";

/**
 * Seed the mock drive with a standard structure for markdown tests.
 */
export function seedDrive(env: IntegrationEnv): void {
  // Reset drive metadata too — some earlier tests overwrite drive.webUrl
  // (e.g. to test the empty-webUrl fallback) and leave it that way.
  env.graphState.drive = {
    id: "mock-drive-1",
    driveType: "business",
    webUrl: "https://contoso-my.sharepoint.com/personal/user_contoso_com/Documents",
  };
  env.graphState.driveRootChildren = [
    { id: "folder-1", name: "Notes", folder: {}, lastModifiedDateTime: "2026-04-10T10:00:00Z" },
    { id: "folder-2", name: "Work", folder: {}, lastModifiedDateTime: "2026-04-11T10:00:00Z" },
  ];
  env.graphState.driveFolderChildren.set("folder-1", [
    {
      id: "file-md-1",
      name: "hello.md",
      size: 5,
      lastModifiedDateTime: "2026-04-10T11:00:00Z",
      file: { mimeType: "text/markdown" },
      content: "hello",
    },
    {
      id: "file-txt",
      name: "readme.txt",
      size: 5,
      lastModifiedDateTime: "2026-04-10T11:00:00Z",
      file: { mimeType: "text/plain" },
      content: "plain",
    },
  ]);
  env.graphState.driveFolderChildren.set("folder-2", []);
  // Historical versions are stored in a separate map that is NOT cleared by
  // replacing driveFolderChildren. Reset it here so version-related tests
  // start from a known-clean state and don't see leftovers from prior runs.
  env.graphState.driveItemVersions.clear();
}
