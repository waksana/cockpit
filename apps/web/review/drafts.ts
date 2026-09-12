import { createSessionDrafts } from '@source/lib/attachmentSend';
export { SessionDraft, stagedAttachments } from '@source/lib/attachmentSend';
export type { SessionDraftSnapshot, UploadFile } from '@source/lib/attachmentSend';

const values = new Map<string, string>();
// Real SessionDraft implementation, but no access to localStorage or formal
// Composer keys. All review edits disappear when this review page is closed.
export const getSessionDraft = createSessionDrafts({
  getItem: key => values.get(`review:${key}`) ?? null,
  setItem: (key, value) => { values.set(`review:${key}`, value); },
  removeItem: key => { values.delete(`review:${key}`); },
});
