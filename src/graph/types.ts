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

/** Date and time with timezone (Graph API pattern). */
export interface DateTimeTimeZone {
  dateTime: string;
  timeZone: string;
}

/** Recurrence pattern (daily, weekly, monthly, yearly). */
export interface RecurrencePattern {
  type: string;
  interval: number;
  daysOfWeek?: string[];
  dayOfMonth?: number;
  month?: number;
  firstDayOfWeek?: string;
  index?: string;
}

/** Recurrence range (end condition). */
export interface RecurrenceRange {
  type: string;
  startDate: string;
  endDate?: string;
  numberOfOccurrences?: number;
}

/** Patterned recurrence combining pattern + range. */
export interface PatternedRecurrence {
  pattern: RecurrencePattern;
  range: RecurrenceRange;
}

/** A checklist item (step) within a todo task. */
export interface ChecklistItem {
  id: string;
  displayName: string;
  isChecked: boolean;
  createdDateTime?: string;
  checkedDateTime?: string;
}

/** A single task in a Microsoft To Do list. */
export interface TodoItem {
  id: string;
  title: string;
  status: string;
  body?: ItemBody;
  importance?: string;
  isReminderOn?: boolean;
  reminderDateTime?: DateTimeTimeZone;
  dueDateTime?: DateTimeTimeZone;
  recurrence?: PatternedRecurrence;
  checklistItems?: ChecklistItem[];
}

/** Wrapper for Graph API collection responses. */
export interface GraphListResponse<T> {
  value: T[];
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
