// Tool registry — shared types and helpers for MCP tool registration.
//
// Each tool lives in its own file under `src/tools/<domain>/` and exports a
// `Tool<Args>` descriptor. The composition root (`src/index.ts`) collects all
// descriptors into one array and registers them in a single loop via
// `registerTool(server, config, tool)`. This file owns the descriptor types,
// the registration helper, and the runtime functions for syncing tool
// enabled/disabled state based on granted scopes (`syncToolState`) and
// generating MCP instructions text from the full set of defs
// (`buildInstructions`).
//
// Tool files conform to a fixed shape:
//
//   const inputSchema = { … };
//   const def: ToolDef = { … };
//   function handler(config: ServerConfig): ToolCallback<typeof inputSchema> { … }
//   export const xxxTool: Tool<typeof inputSchema> = { def, inputSchema, handler };
//
// See ADR-0007.

import type {
  McpServer,
  RegisteredTool,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

import type { ServerConfig } from "./index.js";
import type { GraphScope } from "./scopes.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Static metadata for a tool — single source of truth. */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /**
   * Scopes that enable this tool. The tool is enabled when the granted scopes
   * include ANY of these. An empty array means the tool is always enabled.
   */
  requiredScopes: GraphScope[];
}

/** ToolDef + the live RegisteredTool handle from the MCP SDK. */
export interface ToolEntry extends ToolDef {
  registeredTool: RegisteredTool;
}

/**
 * Self-contained descriptor for a single MCP tool. Composes the static
 * metadata (`def`), the zod input schema, optional output schema and
 * annotations, and a handler factory that takes the injected
 * {@link ServerConfig} and returns the SDK-shaped callback.
 *
 * By convention each tool file declares `inputSchema`, `def`, and `handler`
 * as named top-level pieces and assembles them into the descriptor at the
 * bottom of the file. See ADR-0007.
 */
export interface Tool<Args extends ZodRawShape = ZodRawShape> {
  readonly def: ToolDef;
  readonly inputSchema: Args;
  readonly outputSchema?: ZodRawShape;
  /**
   * Optional MCP annotations. The `title` field is always set from
   * `def.title` by {@link registerTool} and should not be supplied here.
   */
  readonly annotations?: Omit<ToolAnnotations, "title">;
  readonly handler: (config: ServerConfig) => ToolCallback<Args>;
}

/**
 * Erased-args alias for storing tools of differing input shapes in a single
 * heterogeneous collection. Each individual `Tool<Args>` descriptor is still
 * type-checked precisely at its definition site — `AnyTool` only relaxes the
 * type used for arrays and iteration.
 */
// `Tool<any>` is the right erasure here: arrays of differently-shaped tool
// descriptors cannot be expressed via a single concrete `Tool<…>` parameter
// without re-introducing the variance error this alias exists to defeat.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any>;

// ---------------------------------------------------------------------------
// registerTool helper
// ---------------------------------------------------------------------------

/**
 * Register a {@link Tool} descriptor with the MCP server and produce a
 * {@link ToolEntry}. The annotation's `title` is always derived from
 * `tool.def.title` so the two never drift apart.
 */
export function registerTool<Args extends ZodRawShape>(
  server: McpServer,
  config: ServerConfig,
  tool: Tool<Args>,
): ToolEntry {
  const annotations: ToolAnnotations = {
    title: tool.def.title,
    ...(tool.annotations ?? {}),
  };

  const registeredTool = server.registerTool(
    tool.def.name,
    {
      title: tool.def.title,
      description: tool.def.description,
      inputSchema: tool.inputSchema,
      // Only include outputSchema when explicitly provided — passing
      // `undefined` would still register an output-typed tool in some SDK
      // versions and force every result to satisfy the schema.
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      annotations,
    },
    tool.handler(config),
  );

  return {
    name: tool.def.name,
    title: tool.def.title,
    description: tool.def.description,
    requiredScopes: tool.def.requiredScopes,
    registeredTool,
  };
}

// ---------------------------------------------------------------------------
// Dynamic tool state
// ---------------------------------------------------------------------------

/**
 * Enable/disable tools based on granted scopes, then notify the client.
 *
 * A tool is enabled when:
 * - Its requiredScopes array is empty (always-enabled), OR
 * - The grantedScopes contain at least one of its requiredScopes.
 */
export function syncToolState(
  entries: readonly ToolEntry[],
  grantedScopes: readonly GraphScope[],
  server: McpServer,
): void {
  const granted = new Set(grantedScopes);

  for (const entry of entries) {
    const shouldEnable =
      entry.requiredScopes.length === 0 || entry.requiredScopes.some((s) => granted.has(s));

    if (shouldEnable && !entry.registeredTool.enabled) {
      entry.registeredTool.enable();
      logger.debug("tool enabled", { tool: entry.name });
    } else if (!shouldEnable && entry.registeredTool.enabled) {
      entry.registeredTool.disable();
      logger.debug("tool disabled", { tool: entry.name });
    }
  }

  server.sendToolListChanged();
}

// ---------------------------------------------------------------------------
// Instruction generation
// ---------------------------------------------------------------------------

/**
 * Generate MCP instructions text from the full tool registry.
 *
 * Groups tools by their scope requirements and includes behavior rules.
 */
export function buildInstructions(defs: readonly ToolDef[]): string {
  const lines: string[] = [];

  lines.push(
    "graphdo gives you scoped access to Microsoft Graph (Outlook mail, Microsoft To Do, and more).",
  );
  lines.push("");
  lines.push("Tools are dynamically enabled based on the OAuth scopes granted during login.");
  lines.push("Only tools matching your granted scopes will be visible.");
  lines.push("");

  // Always-available tools
  const alwaysAvailable = defs.filter((d) => d.requiredScopes.length === 0);
  if (alwaysAvailable.length > 0) {
    lines.push("ALWAYS AVAILABLE:");
    for (const d of alwaysAvailable) {
      lines.push(`  - ${d.name}: ${d.description}`);
    }
    lines.push("");
  }

  // Group scope-gated tools by their scope requirements
  const scopeGated = defs.filter((d) => d.requiredScopes.length > 0);
  const scopeGroups = new Map<string, ToolDef[]>();
  for (const d of scopeGated) {
    const key = d.requiredScopes.slice().sort().join(", ");
    const group = scopeGroups.get(key);
    if (group) {
      group.push(d);
    } else {
      scopeGroups.set(key, [d]);
    }
  }

  if (scopeGroups.size > 0) {
    lines.push("SCOPE-GATED TOOLS:");
    for (const [scopes, tools] of scopeGroups) {
      lines.push(`  Requires ${scopes}:`);
      for (const d of tools) {
        lines.push(`    - ${d.name}: ${d.description}`);
      }
    }
    lines.push("");
  }

  lines.push("IMPORTANT BEHAVIOR RULES:");
  lines.push(
    "- When a tool returns an authentication error, call the login tool immediately - " +
      "do not ask the user whether they want to log in.",
  );
  lines.push(
    "- When a tool returns a 'todo list not configured' error, call the todo_select_list " +
      "tool immediately - do not ask the user which list to use, the tool opens a " +
      "browser picker where the user selects the list themselves.",
  );
  lines.push("- Use auth_status as a first step when diagnosing issues.");
  lines.push("");
  lines.push(
    "WORKFLOW: On first use, call login (automatic browser sign-in), then " +
      "todo_select_list (browser-based list selection), then the user's requested action.",
  );

  return lines.join("\n");
}
