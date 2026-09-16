import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function exportModuleApi(destination) {
  const source = fileURLToPath(new URL('../packages/', import.meta.url));
  const output = resolve(destination);
  await mkdir(output);
  for (const name of ['module-api', 'protocol']) {
    const root = join(source, name);
    const target = join(output, name);
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).map(([key, value]) =>
      [key, value === 'workspace:*' && key === '@cockpit/protocol' ? 'file:../protocol' : value]));
    await mkdir(target);
    await cp(join(root, 'src'), join(target, 'src'), {
      recursive: true,
      filter: path => !/\.(?:test|spec)\.[^.]+$/.test(path),
    });
    await writeFile(join(target, 'package.json'), JSON.stringify({
      name: manifest.name, version: manifest.version, type: manifest.type,
      license: 'GPL-3.0-only', types: manifest.types, main: manifest.main,
      exports: manifest.exports, dependencies,
    }, null, 2) + '\n');
  }
  await cp(fileURLToPath(new URL('../LICENSE', import.meta.url)), join(output, 'LICENSE'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/export-module-api.mjs NEW_DESTINATION');
  await exportModuleApi(process.argv[2]);
}
