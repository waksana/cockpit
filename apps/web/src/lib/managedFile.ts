import type { Attachment } from '@cockpit/protocol';
import { attachmentHref } from './upload';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']);
const VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']);

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 * 1024 ? 'KiB' : 'MiB';
  const size = bytes / (unit === 'KiB' ? 1024 : 1024 * 1024);
  return `${Number(size.toFixed(size < 10 ? 1 : 0))} ${unit}`;
}

export function filePreview(file: Pick<Attachment, 'mime'>): 'image' | 'video' | undefined {
  const mime = file.mime?.split(';', 1)[0].trim().toLowerCase();
  return mime && IMAGE_MIMES.has(mime) ? 'image' : mime && VIDEO_MIMES.has(mime) ? 'video' : undefined;
}

export function fileDownloadUrl(url: string): string | undefined {
  const href = attachmentHref(url);
  return href ? `${href}?download=1` : undefined;
}

export function filesBrowseUrl(url?: string, sessionId?: string): string {
  const query = new URLSearchParams();
  if (url) query.set('url', url);
  if (sessionId) query.set('sessionId', sessionId);
  return `/files${query.size ? `?${query}` : ''}`;
}

export function managedUploadPath(url: string | undefined): string | undefined {
  const href = url && attachmentHref(url.replace(/\?download=1$/, ''));
  return href ? new URL(href, 'https://local.invalid').pathname : undefined;
}

interface MarkdownNode {
  type: string;
  url?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
}

// A linked image represents one file, not two nested cards. Repeated mentions
// stay ordinary download links; only the first occurrence gets a preview.
export function managedFileMentions(options?: { files?: string[] }) {
  return (tree: MarkdownNode) => {
    const seen = new Set<string>(options?.files?.flatMap(url => managedUploadPath(url) ?? []));
    function visit(node: MarkdownNode) {
      if (node.type === 'link' && node.children?.length === 1
        && node.children[0].type === 'image'
        && managedUploadPath(node.url) === managedUploadPath(node.children[0].url)
        && managedUploadPath(node.url)) {
        const image = node.children[0];
        Object.assign(node, image);
        node.children = undefined;
      }
      const url = (node.type === 'link' || node.type === 'image') && managedUploadPath(node.url);
      if (url) {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties,
          'data-managed-preview': !seen.has(url) && seen.size < 20 ? 'yes' : 'no' } };
        seen.add(url);
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}
