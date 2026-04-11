// Tests for icon data URIs — verifies base64-encoded assets are valid.

import { describe, it, expect } from "vitest";
import {
  iconDataUri,
  iconLightDataUri,
  iconDarkDataUri,
} from "../../src/templates/icons.js";

describe("icon data URIs", () => {
  it("exports a valid PNG data URI for default icon", () => {
    expect(iconDataUri).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  });

  it("exports a valid PNG data URI for light icon", () => {
    expect(iconLightDataUri).toMatch(
      /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/,
    );
  });

  it("exports a valid PNG data URI for dark icon", () => {
    expect(iconDarkDataUri).toMatch(
      /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/,
    );
  });

  it("icons are non-trivial size (actual image data)", () => {
    // Each icon is ~2–3 KB raw, so base64 should be at least 1000 chars
    expect(iconDataUri.length).toBeGreaterThan(1000);
    expect(iconLightDataUri.length).toBeGreaterThan(1000);
    expect(iconDarkDataUri.length).toBeGreaterThan(1000);
  });
});
