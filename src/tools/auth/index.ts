// Auth tool barrel — login, logout, and auth_status.

import type { AnyTool } from "../../tool-registry.js";
import { authStatusTool } from "./auth-status.js";
import { loginTool } from "./login.js";
import { logoutTool } from "./logout.js";

export { loginTool, logoutTool, authStatusTool };

export const AUTH_TOOLS: readonly AnyTool[] = [loginTool, logoutTool, authStatusTool];
