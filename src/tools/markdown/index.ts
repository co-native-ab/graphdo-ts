// Markdown tool barrel.

import type { AnyTool } from "../../tool-registry.js";
import { markdownAppendFileTool } from "./append-file.js";
import { markdownCreateFileTool } from "./create-file.js";
import { markdownDeleteFileTool } from "./delete-file.js";
import { markdownDiffFileVersionsTool } from "./diff-versions.js";
import { markdownEditFileTool } from "./edit-file.js";
import { markdownGetFileTool } from "./get-file.js";
import { markdownGetFileVersionTool } from "./get-version.js";
import { markdownListFilesTool } from "./list-files.js";
import { markdownListFileVersionsTool } from "./list-versions.js";
import { markdownPreviewFileTool } from "./preview-file.js";
import { markdownSelectWorkspaceTool } from "./select-workspace.js";
import { markdownUpdateFileTool } from "./update-file.js";

export {
  markdownSelectWorkspaceTool,
  markdownListFilesTool,
  markdownGetFileTool,
  markdownCreateFileTool,
  markdownUpdateFileTool,
  markdownEditFileTool,
  markdownAppendFileTool,
  markdownDeleteFileTool,
  markdownListFileVersionsTool,
  markdownGetFileVersionTool,
  markdownDiffFileVersionsTool,
  markdownPreviewFileTool,
};

export const MARKDOWN_TOOLS: readonly AnyTool[] = [
  markdownSelectWorkspaceTool,
  markdownListFilesTool,
  markdownGetFileTool,
  markdownCreateFileTool,
  markdownUpdateFileTool,
  markdownEditFileTool,
  markdownAppendFileTool,
  markdownDeleteFileTool,
  markdownListFileVersionsTool,
  markdownGetFileVersionTool,
  markdownDiffFileVersionsTool,
  markdownPreviewFileTool,
];
