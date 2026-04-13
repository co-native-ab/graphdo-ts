// Typed Microsoft Graph scopes used by graphdo.
//
// GraphScope is the single source of truth for scope values.
// All tool defs, scope definitions, config, and authenticator interfaces use this enum.

/** Typed enum for all Microsoft Graph scopes used by graphdo. */
export enum GraphScope {
  MailSend = "Mail.Send",
  TasksReadWrite = "Tasks.ReadWrite",
  UserRead = "User.Read",
  OfflineAccess = "offline_access",
}

/** Human-friendly scope metadata for the login page UI. */
export interface ScopeDefinition {
  scope: GraphScope;
  label: string;
  description: string;
  /** When true, this scope is always included and cannot be deselected. */
  required: boolean;
}

/** All scopes available for selection, in display order. */
export const AVAILABLE_SCOPES: readonly ScopeDefinition[] = [
  {
    scope: GraphScope.UserRead,
    label: "User Profile",
    description: "Read your basic profile information",
    required: true,
  },
  {
    scope: GraphScope.OfflineAccess,
    label: "Stay Signed In",
    description: "Maintain access without re-authenticating",
    required: true,
  },
  {
    scope: GraphScope.MailSend,
    label: "Send Email",
    description: "Send emails from your account",
    required: false,
  },
  {
    scope: GraphScope.TasksReadWrite,
    label: "Manage Tasks",
    description: "Create, update, and delete your Microsoft To Do tasks",
    required: false,
  },
];

/** Scopes that are always required and cannot be deselected. */
export const ALWAYS_REQUIRED_SCOPES: readonly GraphScope[] = AVAILABLE_SCOPES.filter(
  (s) => s.required,
).map((s) => s.scope);

/** Returns all scopes (the default selection). */
export function defaultScopes(): GraphScope[] {
  return AVAILABLE_SCOPES.map((s) => s.scope);
}

const SCOPE_VALUES = new Set<string>(Object.values(GraphScope));

/** Type guard: checks whether a string is a valid GraphScope value. */
export function isGraphScope(value: string): value is GraphScope {
  return SCOPE_VALUES.has(value);
}

/** Filter a string array to only valid GraphScope values. */
export function toGraphScopes(values: readonly string[]): GraphScope[] {
  return values.filter(isGraphScope);
}
