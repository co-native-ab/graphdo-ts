// Barrel re-exports for the browser module.

export { openBrowser } from "./open.js";
export {
  buildLoopbackCsp,
  generateRandomToken,
  validateLoopbackPostHeaders,
  verifyCsrfToken,
} from "./security.js";
export type { HeaderValidationResult, ValidateOptions } from "./security.js";
export { runBrowserFlow, readJsonWithCsrf, respondAndClose } from "./server.js";
export type { BrowserFlow, FlowContext, FlowHandle, RouteTable, RouteHandler } from "./server.js";
export { loginFlow, createMsalLoopback } from "./flows/login.js";
export { pickerFlow, runPicker } from "./flows/picker.js";
export type {
  PickerConfig,
  PickerOption,
  PickerResult,
  PickerCreateLink,
  PickerHandle,
} from "./flows/picker.js";
export { logoutFlow, showLogoutConfirmation } from "./flows/logout.js";
