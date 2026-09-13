import { REVIEW_BASE } from './constants';
import { attachmentHref } from './upload';
export { filePreview, formatFileSize, managedFileMentions, managedUploadPath } from '@source/lib/managedFile';

export function fileDownloadUrl(url: string): string | undefined {
  const href = attachmentHref(url);
  return href ? `${href}?download=1` : undefined;
}
export function filesBrowseUrl(url?: string): string {
  return `${REVIEW_BASE}?file=${encodeURIComponent(url ?? '')}`;
}
