import { z } from 'zod';

export const ChatTextRead = z.object({
  sessionId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  source: z.enum(['persisted', 'live']).default('persisted'),
  direction: z.enum(['forward', 'backward']).default('backward'),
  cursor: z.string().min(1).max(32768).optional(),
  since: z.string().min(1).max(4096).optional(),
  max: z.number().int().min(1).max(64).default(16),
  maxBytes: z.number().int().min(8192).max(65536).default(16384),
  scanPages: z.number().int().min(1).max(16).default(4),
  bootstrap: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.bootstrap && (value.source !== 'live' || value.direction !== 'backward' || value.cursor)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Bootstrap requires a fresh live backward text read.' });
  }
  if (value.since && (value.direction !== 'backward' || value.bootstrap)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'since requires backward reads without bootstrap.' });
  }
});
export type ChatTextRead = z.infer<typeof ChatTextRead>;

export const ChatTextMessage = z.object({
  eventId: z.string(),
  messageId: z.string().optional(),
  role: z.enum(['user', 'assistant']),
  timestamp: z.union([z.string(), z.number()]).optional(),
  content: z.string(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  totalCharacters: z.number().int().nonnegative(),
  attachments: z.array(z.object({
    type: z.string().optional(),
    displayName: z.string().optional(),
    path: z.string().optional(),
    mimeType: z.string().optional(),
    omittedFields: z.boolean(),
  })),
  omittedAttachments: z.number().int().nonnegative(),
});
export type ChatTextMessage = z.infer<typeof ChatTextMessage>;

export const ChatTextPage = z.object({
  sessionId: z.string(),
  source: z.enum(['persisted', 'live']),
  direction: z.enum(['forward', 'backward']),
  view: z.literal('text'),
  order: z.enum(['newest-first', 'oldest-first']),
  messages: z.array(ChatTextMessage),
  cursor: z.string(),
  hasMore: z.boolean(),
  scanLimited: z.boolean(),
  liveCursor: z.string().optional(),
  checkpoint: z.string().optional(),
  read: z.object({
    rpc: z.number().int().nonnegative(),
    pages: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
  }),
});
export type ChatTextPage = z.infer<typeof ChatTextPage>;
