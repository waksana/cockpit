import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateModuleSdk } from './generate-module-sdk.mjs';

test('checked-in SDK wire declarations come from the canonical protocol projection', () => {
  assert.equal(readFileSync(new URL('../packages/module-api/src/wire.ts', import.meta.url), 'utf8'), generateModuleSdk());
});

test('projection follows nested fields and intent results, not schema declaration order', t => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-sdk-projection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'packages/protocol/src');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, 'packages/protocol/tsconfig.json'), '{"compilerOptions":{"strict":true,"skipLibCheck":true}}');
  const source = join(directory, 'module-sdk-projection.ts');
  writeFileSync(source, 'export type Item = { value: string; nested?: { b: boolean; a: number } };');
  const original = generateModuleSdk(root);
  writeFileSync(source, 'export type Item = { nested?: { a: number; b: boolean }; value: string };');
  assert.equal(generateModuleSdk(root), original);
  writeFileSync(source, 'export type Item = { value: string; nested?: { a: number; b: boolean; extra?: string } };');
  assert.notEqual(generateModuleSdk(root), original);
  writeFileSync(source, 'type Intents = { create: { result: { queued?: boolean } } }; export type Map = { [K in keyof Intents]: Intents[K] };');
  assert.match(generateModuleSdk(root), /queued\?: boolean/);
  writeFileSync(source, 'export type Item = any;');
  assert.throws(() => generateModuleSdk(root), /unresolved or internal/);
  writeFileSync(source, "export type Item = import('./missing').Item;");
  assert.throws(() => generateModuleSdk(root), /Cannot find module/);
});
