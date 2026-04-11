// Tests for icon data URIs — verifies SVG assets are valid.

import { describe, it, expect } from "vitest";
import {
  symbolDataUri,
  symbolDarkDataUri,
  symbolLightDataUri,
  logoDataUri,
  logoDarkDataUri,
  logoLightDataUri,
} from "../../src/templates/icons.js";

describe("icon data URIs", () => {
  const allIcons = [
    ["symbolDataUri", symbolDataUri],
    ["symbolDarkDataUri", symbolDarkDataUri],
    ["symbolLightDataUri", symbolLightDataUri],
    ["logoDataUri", logoDataUri],
    ["logoDarkDataUri", logoDarkDataUri],
    ["logoLightDataUri", logoLightDataUri],
  ] as const;

  it.each(allIcons)("%s is a valid SVG data URI", (_name, uri) => {
    expect(uri).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/);
  });

  it.each(allIcons)("%s is non-trivial size (actual image data)", (_name, uri) => {
    expect(uri.length).toBeGreaterThan(500);
  });

  it.each(allIcons)("%s decodes to valid SVG content", (_name, uri) => {
    const b64 = uri.replace("data:image/svg+xml;base64,", "");
    const svg = Buffer.from(b64, "base64").toString("utf-8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });
});
