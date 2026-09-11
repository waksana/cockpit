import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'cockpit-static-'));
writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Fixture app</title>');
mkdirSync(join(directory, 'assets'));
mkdirSync(join(directory, 'retained'));
writeFileSync(join(directory, 'assets', 'current-12345678.js'), 'current');
writeFileSync(join(directory, 'retained', 'previous-12345678.js'), 'previous');
process.env.COCKPIT_NO_BOOT = '1';
process.env.COCKPIT_SERVE_WEB = '1';
process.env.COCKPIT_WEB_DIR = directory;
process.env.COCKPIT_ASSET_DIR = join(directory, 'retained');
process.env.LOG_LEVEL = 'silent';
const { app, registerStaticWeb } = await import('./index.ts');
await registerStaticWeb();
after(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

test('immutable delivery serves current and retained hashed assets without SPA fallback', async () => {
  for (const name of ['current', 'previous']) {
    const response = await app.inject({ method: 'GET', url: `/assets/${name}-12345678.js` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, name);
  }
});

test('SPA fallback serves only recognized application routes', async () => {
  for (const path of ['/', '/session/fixture', '/session/fixture/info', '/mcp', '/skills/project', '/workers/old',
    '/files', '/files?url=%2Fuploads%2Ffixture.mp4&sessionId=fixture']) {
    const response = await app.inject({ method: 'GET', url: path });
    assert.equal(response.statusCode, 200, path);
    assert.match(response.headers['content-type'] ?? '', /text\/html/);
  }
  for (const path of ['/trash', '/trash/fixture', '/intent/session/history', '/uploads/no/such/file', '/health/typo', '/assets/missing.js', '/home/user/chart.png']) {
    const response = await app.inject({ method: 'GET', url: path });
    assert.equal(response.statusCode, 404, path);
    assert.deepEqual(response.json(), { error: 'not found' });
  }
});
