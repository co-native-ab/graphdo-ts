// Status tool barrel.

import type { AnyTool } from "../../tool-registry.js";
import { authStatusTool } from "./auth-status.js";

export { authStatusTool };

export const STATUS_TOOLS: readonly AnyTool[] = [authStatusTool];
