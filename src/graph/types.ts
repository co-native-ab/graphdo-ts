// TypeScript interfaces for Microsoft Graph API entities.
// Mirrors the Go types in internal/graph/.
import { z } from "zod";

// --- String literal union types for Graph API enums ---

export type TodoStatus = "notStarted" | "completed" | "inProgress" | "waitingOnOthers" | "deferred";
export type Importance = "low" | "normal" | "high";
export type BodyContentType = "text" | "html" | "Text" | "HTML";
export type RecurrencePatternType =
  | "daily"
  | "weekly"
  | "absoluteMonthly"
  | "relativeMonthly"
  | "absoluteYearly"
  | "relativeYearly";
export type RecurrenceRangeType = "noEnd" | "endDate" | "numbered";

/** Microsoft Graph user profile. */
export interface User {
  id: string;
  displayName: string;
  mail: string;
  userPrincipalName: string;
}
export const UserSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    mail: z.string(),
    userPrincipalName: z.string(),
  })
  .loose();

/** Microsoft To Do task list. */
export interface TodoList {
  id: string;
  displayName: string;
}
export const TodoListSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
  })
  .loose();

/** Content and format of a todo item body. */
export interface ItemBody {
  content: string;
  contentType: BodyContentType;
}
const ItemBodySchema = z
  .object({
    content: z.string(),
    contentType: z.enum(["text", "html", "Text", "HTML"]),
  })
  .loose();

/** Date and time with timezone (Graph API pattern). */
export interface DateTimeTimeZone {
  dateTime: string;
  timeZone: string;
}
const DateTimeTimeZoneSchema = z
  .object({
    dateTime: z.string(),
    timeZone: z.string(),
  })
  .loose();

/** Recurrence pattern (daily, weekly, monthly, yearly). */
export interface RecurrencePattern {
  type: RecurrencePatternType;
  interval: number;
  daysOfWeek?: string[];
  dayOfMonth?: number;
  month?: number;
  firstDayOfWeek?: string;
  index?: string;
}
const RecurrencePatternSchema = z
  .object({
    type: z.enum([
      "daily",
      "weekly",
      "absoluteMonthly",
      "relativeMonthly",
      "absoluteYearly",
      "relativeYearly",
    ]),
    interval: z.number(),
    daysOfWeek: z.array(z.string()).optional(),
    dayOfMonth: z.number().optional(),
    month: z.number().optional(),
    firstDayOfWeek: z.string().optional(),
    index: z.string().optional(),
  })
  .loose();

/** Recurrence range (end condition). */
export interface RecurrenceRange {
  type: RecurrenceRangeType;
  startDate: string;
  endDate?: string;
  numberOfOccurrences?: number;
}
const RecurrenceRangeSchema = z
  .object({
    type: z.enum(["noEnd", "endDate", "numbered"]),
    startDate: z.string(),
    endDate: z.string().optional(),
    numberOfOccurrences: z.number().optional(),
  })
  .loose();

/** Patterned recurrence combining pattern + range. */
export interface PatternedRecurrence {
  pattern: RecurrencePattern;
  range: RecurrenceRange;
}
const PatternedRecurrenceSchema = z
  .object({
    pattern: RecurrencePatternSchema,
    range: RecurrenceRangeSchema,
  })
  .loose();

/** A checklist item (step) within a todo task. */
export interface ChecklistItem {
  id: string;
  displayName: string;
  isChecked: boolean;
  createdDateTime?: string;
  checkedDateTime?: string;
}
export const ChecklistItemSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    isChecked: z.boolean(),
    createdDateTime: z.string().optional(),
    checkedDateTime: z.string().optional(),
  })
  .loose();

/** A single task in a Microsoft To Do list. */
export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  body?: ItemBody;
  importance?: Importance;
  isReminderOn?: boolean;
  reminderDateTime?: DateTimeTimeZone;
  dueDateTime?: DateTimeTimeZone;
  recurrence?: PatternedRecurrence;
  checklistItems?: ChecklistItem[];
}
export const TodoItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["notStarted", "completed", "inProgress", "waitingOnOthers", "deferred"]),
    body: ItemBodySchema.optional(),
    importance: z.enum(["low", "normal", "high"]).optional(),
    isReminderOn: z.boolean().optional(),
    reminderDateTime: DateTimeTimeZoneSchema.optional(),
    dueDateTime: DateTimeTimeZoneSchema.optional(),
    recurrence: PatternedRecurrenceSchema.optional(),
    checklistItems: z.array(ChecklistItemSchema).optional(),
  })
  .loose();

/** Wrapper for Graph API collection responses. */
export interface GraphListResponse<T> {
  value: T[];
}
export function GraphListResponseSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({ value: z.array(itemSchema) }).loose();
}

// ---------------------------------------------------------------------------
// OneDrive / Drive items
// ---------------------------------------------------------------------------

/**
 * A OneDrive drive item (file or folder).
 *
 * Only the fields graphdo consumes are modelled. Either `file` or `folder` is
 * populated for any real item; the `name` field is always present on persisted
 * drive items returned by the Graph API.
 */
export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  eTag?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
}

export const DriveItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    size: z.number().optional(),
    eTag: z.string().optional(),
    lastModifiedDateTime: z.string().optional(),
    file: z.object({ mimeType: z.string().optional() }).loose().optional(),
    folder: z.object({ childCount: z.number().optional() }).loose().optional(),
  })
  .loose();

/**
 * A OneDrive `drive` resource as returned by `GET /me/drive`.
 *
 * Only the fields graphdo consumes are modelled. `webUrl` is the user-facing
 * URL of the drive in OneDrive (e.g. the root folder in the OneDrive web UI).
 * See https://learn.microsoft.com/en-us/graph/api/drive-get.
 */
export interface Drive {
  id: string;
  driveType?: string;
  webUrl?: string;
}

export const DriveSchema = z
  .object({
    id: z.string(),
    driveType: z.string().optional(),
    webUrl: z.string().optional(),
  })
  .loose();

/**
 * A single historical version of a OneDrive drive item, as returned by
 * `GET /me/drive/items/{id}/versions`. See
 * https://learn.microsoft.com/en-us/graph/api/driveitem-list-versions.
 *
 * The ID is an opaque string assigned by OneDrive (for SharePoint-backed
 * drives it looks like "1.0", "2.0", etc., but code must treat it as opaque).
 * `lastModifiedBy.user.displayName` is populated on SharePoint/business drives
 * but may be absent on personal OneDrive.
 */
export interface DriveItemVersion {
  id: string;
  lastModifiedDateTime?: string;
  size?: number;
  lastModifiedBy?: {
    user?: {
      displayName?: string;
      email?: string;
    };
  };
}

export const DriveItemVersionSchema = z
  .object({
    id: z.string(),
    lastModifiedDateTime: z.string().optional(),
    size: z.number().optional(),
    lastModifiedBy: z
      .object({
        user: z
          .object({
            displayName: z.string().optional(),
            email: z.string().optional(),
          })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

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
  contentType: BodyContentType;
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
