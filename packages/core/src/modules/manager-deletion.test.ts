import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OfficialRuntime } from '../runtime.ts';
import { ModuleManager } from './manager.ts';

for (const phase of ['failed', 'unknown'] as const) {
  test(`confirmed deletion archives a ${phase} application without retaining an uninstall-blocking live reference`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'module-deleted-binding-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const manager = new ModuleManager({ runtime: new OfficialRuntime(), userRoot: join(root, 'user') });
    await manager.install('assistant');
    const record = manager.catalog.prepareBinding('deleted-session',
      [{ moduleId: 'assistant', roleId: 'assistant', version: '1.0.0' }], 'failed-before-delete');
    const failed = manager.catalog.setBinding({ ...record, phase, error: 'Synthetic partial application' }, record.revision);
    assert.throws(() => manager.catalog.removeBinding(record.sessionId, failed.revision), /unfinished/);
    const data = manager.catalog.dataDirectory('assistant');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'keep.txt'), 'User-owned data');
    // Engine calls removed only after the native deletion acknowledgement.
    await manager.removed(record.sessionId);
    assert.equal(manager.catalog.getBinding(record.sessionId), undefined);
    const archive = join(root, 'user', 'session-module-history', `${record.sessionId}-${failed.revision}.json`);
    assert.deepEqual(JSON.parse(readFileSync(archive, 'utf8')), failed);
    assert.equal(statSync(archive).mode & 0o777, 0o600);
    await manager.uninstall('assistant');
    assert.equal(readFileSync(join(data, 'keep.txt'), 'utf8'), 'User-owned data');
    assert.deepEqual(JSON.parse(readFileSync(archive, 'utf8')), failed);
  });
}
