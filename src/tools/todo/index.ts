// Todo tool barrel.

import type { AnyTool } from "../../tool-registry.js";
import { todoCompleteTool } from "./todo-complete.js";
import { todoCreateTool } from "./todo-create.js";
import { todoDeleteTool } from "./todo-delete.js";
import { todoListTool } from "./todo-list.js";
import { todoShowTool } from "./todo-show.js";
import { todoUpdateTool } from "./todo-update.js";
import { todoAddStepTool } from "./steps/todo-add-step.js";
import { todoDeleteStepTool } from "./steps/todo-delete-step.js";
import { todoStepsTool } from "./steps/todo-steps.js";
import { todoUpdateStepTool } from "./steps/todo-update-step.js";

export {
  todoListTool,
  todoShowTool,
  todoCreateTool,
  todoUpdateTool,
  todoCompleteTool,
  todoDeleteTool,
  todoStepsTool,
  todoAddStepTool,
  todoUpdateStepTool,
  todoDeleteStepTool,
};

export const TODO_TOOLS: readonly AnyTool[] = [
  todoListTool,
  todoShowTool,
  todoCreateTool,
  todoUpdateTool,
  todoCompleteTool,
  todoDeleteTool,
  todoStepsTool,
  todoAddStepTool,
  todoUpdateStepTool,
  todoDeleteStepTool,
];
