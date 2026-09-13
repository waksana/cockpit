import { attachmentHref as originalHref } from '@source/lib/upload';
import { REVIEW_BASE } from './constants';
export { validateUploadFile, uploadedAttachment } from '@source/lib/upload';

export function attachmentHref(url: string): string | undefined {
  const original = originalHref(url, '');
  return original?.startsWith('/uploads/') ? `${REVIEW_BASE}media/${original.slice('/uploads/'.length)}` : undefined;
}
export async function uploadFile(): Promise<never> {
  throw new Error('Review files remain local; no upload endpoint is available.');
}
