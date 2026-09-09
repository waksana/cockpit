import type { DirListing } from '@cockpit/protocol';

export async function readDirectory(listDir: (path?: string) => Promise<DirListing>, path?: string): Promise<DirListing> {
  const listing = await listDir(path);
  if (!listing.path.trim()) throw new Error('服务器未返回有效的工作目录。');
  return listing;
}
