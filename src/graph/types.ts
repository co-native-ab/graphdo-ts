// TypeScript interfaces for Microsoft Graph API entities.
// Mirrors the Go types in internal/graph/.
import { z } from "zod";

// --- String literal union types for Graph API enums ---

export type TodoStatus = "notStarted" | "completed" | "inProgress" | "waitingOnOthers" | "deferred";
export type Importance = "low" | "normal" | "high";
export type BodyContentType = "text" | "html" | "Text" | "HTML";
export type RecurrencePatternType = "daily" | "weekly" | "absoluteMonthly" | "relativeMonthly" | "absoluteYearly" | "relativeYearly";
export type RecurrenceRangeType = "noEnd" | "endDate" | "numbered";

/** Microsoft Graph user profile. */
export interface User {
  id: string;
  displayName: string;
  mail: string;
  userPrincipalName: string;
}
export const UserSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  mail: z.string(),
  userPrincipalName: z.string(),
}).loose();

/** Microsoft To Do task list. */
export interface TodoList {
  id: string;
  displayName: string;
}
export const TodoListSchema = z.object({
  id: z.string(),
  displayName: z.string(),
}).loose();

/** Content and format of a todo item body. */
export interface ItemBody {
  content: string;
  contentType: BodyContentType;
}
export const ItemBodySchema = z.object({
  content: z.string(),
  contentType: z.enum(["text", "html", "Text", "HTML"]),
}).loose();

/** Date and time with timezone (Graph API pattern). */
export interface DateTimeTimeZone {
  dateTime: string;
  timeZone: string;
}
export const DateTimeTimeZoneSchema = z.object({
  dateTime: z.string(),
  timeZone: z.string(),
}).loose();

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
export const RecurrencePatternSchema = z.object({
  type: z.enum(["daily", "weekly", "absoluteMonthly", "relativeMonthly", "absoluteYearly", "relativeYearly"]),
  interval: z.number(),
  daysOfWeek: z.array(z.string()).optional(),
  dayOfMonth: z.number().optional(),
  month: z.number().optional(),
  firstDayOfWeek: z.string().optional(),
  index: z.string().optional(),
}).loose();

/** Recurrence range (end condition). */
export interface RecurrenceRange {
  type: RecurrenceRangeType;
  startDate: string;
  endDate?: string;
  numberOfOccurrences?: number;
}
export const RecurrenceRangeSchema = z.object({
  type: z.enum(["noEnd", "endDate", "numbered"]),
  startDate: z.string(),
  endDate: z.string().optional(),
  numberOfOccurrences: z.number().optional(),
}).loose();

/** Patterned recurrence combining pattern + range. */
export interface PatternedRecurrence {
  pattern: RecurrencePattern;
  range: RecurrenceRange;
}
export const PatternedRecurrenceSchema = z.object({
  pattern: RecurrencePatternSchema,
  range: RecurrenceRangeSchema,
}).loose();

/** A checklist item (step) within a todo task. */
export interface ChecklistItem {
  id: string;
  displayName: string;
  isChecked: boolean;
  createdDateTime?: string;
  checkedDateTime?: string;
}
export const ChecklistItemSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  isChecked: z.boolean(),
  createdDateTime: z.string().optional(),
  checkedDateTime: z.string().optional(),
}).loose();

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
export const TodoItemSchema = z.object({
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
}).loose();

/** Wrapper for Graph API collection responses. */
export interface GraphListResponse<T> {
  value: T[];
}
export function GraphListResponseSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({ value: z.array(itemSchema) }).loose();
}

/** Graph API error response envelope. */
export interface GraphErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}
export const GraphErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).loose(),
}).loose();

// --- SendMail request types ---

export interface SendMailAddress {
  address: string;
}
export const SendMailAddressSchema = z.object({
  address: z.string(),
}).loose();

export interface SendMailRecipient {
  emailAddress: SendMailAddress;
}
export const SendMailRecipientSchema = z.object({
  emailAddress: SendMailAddressSchema,
}).loose();

export interface SendMailBody {
  contentType: BodyContentType;
  content: string;
}
export const SendMailBodySchema = z.object({
  contentType: z.enum(["text", "html", "Text", "HTML"]),
  content: z.string(),
}).loose();

export interface SendMailMessage {
  subject: string;
  body: SendMailBody;
  toRecipients: SendMailRecipient[];
}
export const SendMailMessageSchema = z.object({
  subject: z.string(),
  body: SendMailBodySchema,
  toRecipients: z.array(SendMailRecipientSchema),
}).loose();

export interface SendMailRequest {
  message: SendMailMessage;
}
export const SendMailRequestSchema = z.object({
  message: SendMailMessageSchema,
}).loose();
