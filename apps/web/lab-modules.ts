import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ModuleAsset } from '@cockpit/module-api/frontend';

const maxFileBytes = 1024 * 1024;
const nativePrefix = '/synthetic/lab/files/';
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const safePath = (value: unknown): value is string => typeof value === 'string'
  && !value.includes('\\') && [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

interface Asset {
  bytes: Buffer;
  mime: string;
}
export interface LabModules {
  modules: ModuleAsset[];
  assets: ReadonlyMap<string, Asset>;
}

export async function loadLabModules(roots: { file?: string; speech?: string }): Promise<LabModules> {
  const modules: ModuleAsset[] = [];
  const assets = new Map<string, Asset>();
  for (const [kind, requested] of Object.entries(roots)) {
    if (!requested) continue;
    if (!isAbsolute(requested)) throw new Error('Lab module roots must be absolute extracted package directories');
    const root = await realpath(requested);
    const receiptText = await readFile(join(root, 'module-build.json'), 'utf8');
    const receipt: unknown = JSON.parse(receiptText);
    const manifestBytes = await readFile(join(root, 'cockpit.module.json'));
    const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
    const id = `cockpit-${kind}`;
    if (!record(receipt) || receipt.format !== 1 || receipt.product !== id || !Array.isArray(receipt.files)
      || typeof receipt.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(receipt.sourceSha)
      || !record(manifest) || manifest.id !== id || typeof manifest.name !== 'string'
      || typeof manifest.version !== 'string' || receipt.version !== manifest.version
      || !record(manifest.frontend) || !Array.isArray(manifest.frontend.assets)
      || !manifest.frontend.assets.every(safePath)) {
      throw new Error(`Invalid clean synthetic module package: ${id}`);
    }
    const frontend = manifest.frontend;
    const declaredRoots = frontend.assets;
    if (!Array.isArray(declaredRoots)) throw new Error('Invalid lab asset roots');
    const inventory = new Map<string, { bytes: number; sha256: string }>();
    for (const entry of receipt.files) {
      if (!record(entry) || !safePath(entry.path) || typeof entry.bytes !== 'number'
        || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || inventory.has(entry.path)) {
        throw new Error(`Invalid lab package inventory: ${id}`);
      }
      inventory.set(entry.path, { bytes: entry.bytes, sha256: entry.sha256 });
    }
    if (inventory.get('cockpit.module.json')?.sha256 !== hash(manifestBytes)) {
      throw new Error(`Lab module manifest differs from its receipt: ${id}`);
    }
    const digest = hash(receiptText);
    const assetRoot = `/_modules/assets/${id}/${digest}/`;
    const apiBase = `/_modules/${id}/${digest}/api`;
    for (const [path, expected] of inventory) {
      if (!declaredRoots.some(prefix => typeof prefix === 'string' && path.startsWith(`${prefix}/`))) continue;
      if (!/\.(?:js|css)$/.test(path)) continue;
      const file = join(root, path);
      const resolved = await realpath(file);
      const within = relative(root, resolved);
      const stat = await lstat(file);
      if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)
        || !stat.isFile() || stat.size > maxFileBytes || stat.size !== expected.bytes) {
        throw new Error(`Unsafe or oversized lab asset: ${path}`);
      }
      const bytes = await readFile(file);
      if (hash(bytes) !== expected.sha256) throw new Error(`Lab asset differs from its receipt: ${path}`);
      assets.set(`${assetRoot}${path}`, { bytes, mime: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
    }
    const entry = (value: unknown) => {
      if (!safePath(value) || !assets.has(`${assetRoot}${value}`)) throw new Error(`Missing declared lab asset: ${id}`);
      return `${assetRoot}${value}`;
    };
    const styles = (value: unknown) => {
      if (value === undefined) return [];
      if (!Array.isArray(value)) throw new Error('Invalid lab styles');
      return value.map(entry);
    };
    modules.push({
      id, name: manifest.name, version: manifest.version, digest, apiBase,
      entry: entry(frontend.entry), styles: styles(frontend.styles),
      config: kind === 'file' ? { nativePathPrefix: nativePrefix, maxBytes: maxFileBytes } : {},
    });
  }
  return { modules, assets };
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += value.length;
    if (bytes > maxFileBytes) throw new Error('Synthetic upload exceeds 1 MiB');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function labModuleHandler(loaded: LabModules) {
  const files = new Map<string, { bytes: Buffer; mime: string; name: string; operation: string }>();
  const fileModule = loaded.modules.find(module => module.id === 'cockpit-file');
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';
    const path = url.pathname;
    if (path === '/_modules') {
      json(response, method === 'GET' ? 200 : 405, { apiVersion: 1, modules: loaded.modules, errors: [] });
      return true;
    }
    if (path.startsWith('/_modules/assets/')) {
      const asset = loaded.assets.get(path);
      if (!asset || !['GET', 'HEAD'].includes(method)) { response.writeHead(404).end(); return true; }
      response.writeHead(200, { 'content-type': asset.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(method === 'HEAD' ? undefined : asset.bytes);
      return true;
    }
    if (!fileModule || !path.startsWith(`${fileModule.apiBase}/`)) return false;
    const action = path.slice(fileModule.apiBase.length);
    if (action === '/upload' && method === 'POST') {
      const name = url.searchParams.get('name') ?? '';
      const operation = url.searchParams.get('operationId') ?? '';
      if (!name || name.length > 512 || !/^[a-zA-Z0-9_-]{1,128}$/.test(operation)) throw new Error('Invalid synthetic upload');
      const bytes = await body(request);
      const id = `f_${hash(operation)}`;
      const requestedMime = request.headers['x-file-mime'];
      const mime = typeof requestedMime === 'string' && /^(?:image\/(?:png|jpeg|gif|webp)|audio\/(?:wav|mpeg|ogg)|video\/(?:mp4|webm))$/.test(requestedMime)
        ? requestedMime : 'application/octet-stream';
      files.set(id, { bytes, mime, name, operation });
      json(response, 200, { fileId: id, attachment: { type: 'file', path: `${nativePrefix}${id}/ready/body`, displayName: name } });
      return true;
    }
    if (/^\/uploads\/[a-zA-Z0-9_-]+$/.test(action) && method === 'DELETE') {
      const operation = action.slice('/uploads/'.length);
      for (const [id, file] of files) if (file.operation === operation) files.delete(id);
      response.writeHead(204).end();
      return true;
    }
    const match = /^\/files\/(f_[a-f0-9]{64})\/body$/.exec(action);
    const file = match ? files.get(match[1]) : undefined;
    if (file && ['GET', 'HEAD'].includes(method)) {
      response.writeHead(200, {
        'content-type': file.mime, 'content-length': file.bytes.length, 'cache-control': 'no-store',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'x-content-type-options': 'nosniff',
      });
      response.end(method === 'HEAD' ? undefined : file.bytes);
    } else response.writeHead(404).end('No synthetic file');
    return true;
  };
  return {
    handle,
    dispose() {
      files.clear();
    },
  };
}
