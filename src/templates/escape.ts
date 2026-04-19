// HTML escaping helper for browser-facing templates.
//
// All variable interpolation in tool-rendered HTML (forms, picker pages,
// re-prompts) MUST pass through this helper. See `docs/plans/collab-v1.md`
// §5.4 (loopback hardening, item 7) for the rationale: the collab v1 forms
// inherit a hardened substrate by routing every interpolation through one
// audited helper rather than relying on per-template ad-hoc escaping.

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
