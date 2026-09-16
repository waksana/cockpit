import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { ModuleManifest, NativeObservation } from '@cockpit/module-api';

export interface TarEntry { path: string; content?: string | Buffer; kind?: string; link?: string; size?: number }
export function archive(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write((entry.size ?? content.length).toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write(entry.kind ?? '0', 156);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

export function moduleEntries(id = 'fixture', backend = 'export function activate() { return { routes: [] }; }', change: Partial<ModuleManifest> = {}): TarEntry[] {
  const manifest: ModuleManifest = {
    apiVersion: 1, id, name: `Fixture ${id}`, version: '1.0.0', backend: 'backend.mjs',
    frontend: { entry: 'web/index.js', styles: ['web/style.css'], assets: ['web'] },
    ...change,
  };
  return [
    { path: 'cockpit.module.json', content: JSON.stringify(manifest) },
    { path: 'backend.mjs', content: backend },
    { path: 'web/index.js', content: 'export function activate() { return {}; }' },
    { path: 'web/style.css', content: '.fixture { color: blue; }' },
  ];
}

export async function removeFixture(path: string): Promise<void> {
  const unseal = async (directory: string): Promise<void> => {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(directory, entry.name));
  };
  await unseal(path);
  await rm(path, { force: true, recursive: true });
}

export async function moduleFixture(t: TestContext) {
  const root = resolve(`.module-test-${randomUUID()}`);
  await mkdir(root);
  const hostRoot = join(root, 'host');
  t.after(() => removeFixture(root));
  for (const [key, value] of Object.entries({ HOME: root, COCKPIT_HOME: hostRoot, COCKPIT_NO_BOOT: '1' })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const listeners = new Set<(observation: NativeObservation) => void | Promise<void>>();
  return {
    root, hostRoot, listeners,
    observer: { onNativeEvent(handler: (observation: NativeObservation) => void | Promise<void>) {
      listeners.add(handler);
      return () => { listeners.delete(handler); };
    } },
    async package(entries = moduleEntries()): Promise<string> {
      const path = join(root, `${randomUUID()}.tgz`);
      await writeFile(path, archive(entries));
      return path;
    },
    emit(type = 'assistant.message_delta') {
      const event: NativeObservation = { sessionId: 'synthetic-session', cwd: root, event: {
        id: randomUUID(), type, data: { messageId: 'synthetic-message', deltaContent: 'hello' }, ephemeral: true,
      } };
      for (const listener of listeners) void listener(event);
    },
  };
}
