// Tool registry — single source of truth for tool metadata and dynamic state.
//
// Each domain module (mail, todo, …) exports its own ToolDef array and register
// function. This file provides the shared types, the defineTool() helper that
// registers a tool AND returns a registry entry, and the runtime functions for
// syncing tool enabled/disabled state based on granted scopes.

import type {
  McpServer,
  RegisteredTool,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

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

// ---------------------------------------------------------------------------
// defineTool helper
// ---------------------------------------------------------------------------

/**
 * Register a tool with the MCP server and produce a ToolEntry.
 *
 * Combines tool metadata (from a ToolDef) with MCP registration into a single
 * call so metadata and registration can never drift apart.
 */
export function defineTool<Args extends ZodRawShape>(
  server: McpServer,
  def: ToolDef,
  toolConfig: {
    inputSchema: Args;
    annotations?: ToolAnnotations;
  },
  handler: ToolCallback<Args>,
): ToolEntry {
  const registeredTool = server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: toolConfig.inputSchema,
      annotations: toolConfig.annotations,
    },
    handler,
  );

  return {
    name: def.name,
    title: def.title,
    description: def.description,
    requiredScopes: def.requiredScopes,
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
    "- When a tool returns a 'todo list not configured' error, call the todo_config " +
      "tool immediately - do not ask the user which list to use, the tool opens a " +
      "browser picker where the user selects the list themselves.",
  );
  lines.push("- Use auth_status as a first step when diagnosing issues.");
  lines.push("");
  lines.push(
    "WORKFLOW: On first use, call login (automatic browser sign-in), then " +
      "todo_config (browser-based list selection), then the user's requested action.",
  );

  return lines.join("\n");
}
