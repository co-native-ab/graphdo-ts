// Mail tool barrel.

import type { AnyTool } from "../../tool-registry.js";
import { mailSendTool } from "./mail-send.js";

export { mailSendTool };

export const MAIL_TOOLS: readonly AnyTool[] = [mailSendTool];
