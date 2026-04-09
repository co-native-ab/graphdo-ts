// TypeScript interfaces for Microsoft Graph API entities.
// Mirrors the Go types in internal/graph/.

/** Microsoft Graph user profile. */
export interface User {
  id: string;
  displayName: string;
  mail: string;
  userPrincipalName: string;
}

/** Microsoft To Do task list. */
export interface TodoList {
  id: string;
  displayName: string;
}

/** Content and format of a todo item body. */
export interface ItemBody {
  content: string;
  contentType: string;
}

/** A single task in a Microsoft To Do list. */
export interface TodoItem {
  id: string;
  title: string;
  status: string;
  body?: ItemBody;
}

/** Wrapper for Graph API collection responses. */
export interface GraphListResponse<T> {
  value: T[];
}

/** Structured error from the Microsoft Graph API. */
export interface GraphAPIError {
  code: string;
  message: string;
  statusCode: number;
}

/** Graph API error response envelope. */
export interface GraphErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

// --- SendMail request types ---

export interface SendMailAddress {
  address: string;
}

export interface SendMailRecipient {
  emailAddress: SendMailAddress;
}

export interface SendMailBody {
  contentType: string;
  content: string;
}

export interface SendMailMessage {
  subject: string;
  body: SendMailBody;
  toRecipients: SendMailRecipient[];
}

export interface SendMailRequest {
  message: SendMailMessage;
}
