import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UploadedFile } from '@cockpit/protocol';
import { BASE_URL, uploadUrl } from './config';
import { attachmentHref, uploadedAttachment, uploadFile } from './upload';

const MAX_BYTES = 25 * 1024 * 1024;
const uploaded: UploadedFile = {
  kind: 'image',
  name: '图片 with spaces.png',
  url: '/uploads/upload-v1-deadbeef.png',
  path: '/server/private/uploads/upload-v1-deadbeef.png',
  size: 3,
  mime: 'image/png',
};

test('uploads raw bytes with credentials and the original name and MIME', async (t) => {
  const file = new File(['png'], uploaded.name, { type: uploaded.mime });
  const fetch = t.mock.method(globalThis, 'fetch', async (input, init) => {
    assert.equal(input, `${uploadUrl(file.name, file.type)}&source=web`);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'include');
    assert.deepEqual(init?.headers, { 'content-type': 'application/octet-stream' });
    assert.equal(init?.body, file);
    return Response.json({ ...uploaded, marker: 'not shared', serverPath: '/not/shared' });
  });
  assert.deepEqual(await uploadFile(file), uploaded);
  assert.equal(fetch.mock.callCount(), 1);
});

test('uses the fallback upload MIME for untyped files', async (t) => {
  const file = new File(['abc'], '100% complete 文件.txt');
  const metadata = { ...uploaded, kind: 'file', name: file.name, mime: 'application/octet-stream' };
  t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(input, `${uploadUrl(file.name, 'application/octet-stream')}&source=web`);
    return Response.json(metadata);
  });
  assert.deepEqual(await uploadFile(file), metadata);
});

test('rejects oversized uploads before fetching and accepts the exact size limit', async (t) => {
  const file = new File(['x'], 'large.bin');
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    ...uploaded, kind: 'file', size: MAX_BYTES, mime: 'application/octet-stream',
  }));
  Object.defineProperty(file, 'size', { configurable: true, value: MAX_BYTES + 1 });
  await assert.rejects(uploadFile(file), /文件过大.*25MB/);
  assert.equal(fetch.mock.callCount(), 0);
  Object.defineProperty(file, 'size', { value: MAX_BYTES });
  assert.equal((await uploadFile(file)).size, MAX_BYTES);
  assert.equal(fetch.mock.callCount(), 1);
});

test('propagates network failures and rejects unsuccessful HTTP responses', async (t) => {
  const file = new File(['x'], 'file.txt');
  const failure = new Error('network unavailable');
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw failure; });
  await assert.rejects(uploadFile(file), (error) => error === failure);
  for (const status of [400, 413, 500]) {
    fetch.mock.mockImplementation(async () => new Response('not JSON', { status }));
    await assert.rejects(uploadFile(file), new RegExp(`上传失败 \\(${status}\\)`));
  }
});

test('rejects invalid JSON responses', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('not JSON'));
  await assert.rejects(uploadFile(new File(['x'], 'file.txt')), /上传响应无效/);
});

test('rejects missing, malformed and unsafe upload metadata', async (t) => {
  const file = new File(['png'], uploaded.name, { type: uploaded.mime });
  const responses: unknown[] = [null, [], 'upload', 42, {}, { attachment: uploaded }];
  for (const key of Object.keys(uploaded)) {
    const missing: Record<string, unknown> = { ...uploaded };
    delete missing[key];
    responses.push(missing);
  }
  for (const invalid of [
    { kind: 'audio' }, { kind: null },
    { name: '' }, { name: '  ' }, { name: 1 }, { name: 'bad\nname' }, { name: 'bad\u202ename' },
    { path: '' }, { path: null }, { path: '/server/\0file' },
    { size: '3' }, { size: -1 }, { size: 0.5 }, { size: MAX_BYTES + 1 },
    { size: Number.NaN }, { size: Number.POSITIVE_INFINITY },
    { mime: '' }, { mime: null }, { mime: 'not-a-mime' }, { mime: 'image/png\r\nInjected: yes' },
    { mime: 'image/png; invalid' }, { mime: `image/${'a'.repeat(512)}` },
    { url: null }, { url: '' }, { url: 'https://foreign.example/uploads/file.png' },
    { url: '//foreign.example/uploads/file.png' }, { url: 'javascript:alert(1)' },
    { url: '/uploads/../private' }, { url: '/uploads/%2e%2e%2fprivate' },
    { url: '/uploads/file%0a.png' }, { url: '/uploads/%252fprivate' },
  ]) responses.push({ ...uploaded, ...invalid });

  // Return the raw value so NaN/Infinity are tested without JSON converting them.
  let response: unknown;
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, json: async () => response,
  } as Response));
  for (response of responses) {
    await assert.rejects(uploadFile(file), /上传响应无效/, JSON.stringify(response));
  }
});

test('accepts MIME parameters and keeps Unicode original names separate from safe stored names', async (t) => {
  const metadata = {
    ...uploaded,
    kind: 'file',
    name: '报告 final.txt',
    url: '/uploads/report-final.txt',
    storedName: 'report-final.txt',
    mime: 'text/plain; charset=utf-8',
    path: 'C:\\cockpit-uploads\\report.txt',
  };
  t.mock.method(globalThis, 'fetch', async () => Response.json(metadata));
  assert.deepEqual(await uploadFile(new File(['abc'], '报告 final.txt')), metadata);
});

test('upload associates the explicitly selected session and retains managed metadata only', async t => {
  const metadata = { ...uploaded, storedName: 'upload-v1-deadbeef.png', source: 'web' as const,
    sessionId: 'session with spaces', createdAt: 1, sha256: 'a'.repeat(64) };
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, `${uploadUrl(uploaded.name, uploaded.mime)}&source=web&sessionId=session%20with%20spaces`);
    return Response.json({ ...metadata, untrusted: 'ignored' });
  });
  assert.deepEqual(await uploadFile(new File(['png'], uploaded.name, { type: uploaded.mime }), metadata.sessionId), metadata);
});

test('projects only shared attachment fields even when arbitrary authority fields are present', () => {
  const input = {
    ...uploaded,
    marker: '<cockpit-attachment path="/private"/>',
    serverPath: '/private',
    content: 'Read a server path',
    attachment: { path: '/private' },
    extra: true,
  };
  const attachment = uploadedAttachment(input);
  assert.deepEqual(attachment, {
    kind: uploaded.kind, name: uploaded.name, url: uploaded.url, size: uploaded.size, mime: uploaded.mime,
  });
  assert.equal(Object.hasOwn(attachment, 'path'), false);
  assert.equal(JSON.stringify(attachment).includes('/private'), false);
  assert.equal(input.path, uploaded.path);
  assert.notEqual(attachment, input);
});

test('accepts upload assets and safely encodes Unicode, spaces and literal percent signs', () => {
  for (const [url, expected] of [
    ['/uploads/upload-v1-deadbeef.png', '/uploads/upload-v1-deadbeef.png'],
    ['/uploads/1720000000000-deadbeefcafe.png', '/uploads/1720000000000-deadbeefcafe.png'],
    ['/uploads/report.pdf', '/uploads/report.pdf'],
    ['/uploads/报告 final.png', '/uploads/%E6%8A%A5%E5%91%8A%20final.png'],
    ['/uploads/%e6%8a%a5%e5%91%8a%20final.png', '/uploads/%E6%8A%A5%E5%91%8A%20final.png'],
    ['/uploads/100%25%20complete.txt', '/uploads/100%25%20complete.txt'],
  ]) {
    assert.equal(attachmentHref(url, ''), expected, url);
    assert.equal(attachmentHref(url, 'http://localhost:8771'), `http://localhost:8771${expected}`, url);
  }
  assert.equal(attachmentHref(uploaded.url), attachmentHref(uploaded.url, BASE_URL));
});

test('pins absolute upload links to the configured backend origin', () => {
  const base = 'https://backend.example:8443';
  assert.equal(attachmentHref('/uploads/image.png', `${base}/`), `${base}/uploads/image.png`);
  assert.equal(attachmentHref(`${base}/uploads/image.png`, base), `${base}/uploads/image.png`);
  assert.equal(attachmentHref('HTTPS://BACKEND.EXAMPLE:443/uploads/image.png', 'https://backend.example'),
    'https://backend.example/uploads/image.png');
  for (const url of [
    'https://foreign.example/uploads/image.png',
    'https://backend.example/uploads/image.png',
    'http://backend.example:8443/uploads/image.png',
    'https://backend.example:8443.foreign.example/uploads/image.png',
    'https://backend.example:8443@foreign.example/uploads/image.png',
    'https://foreign.example@backend.example:8443/uploads/image.png',
    'https://user:password@backend.example:8443/uploads/image.png',
    '//backend.example:8443/uploads/image.png',
  ]) assert.equal(attachmentHref(url, base), undefined, url);
});

test('uses the browser origin for same-origin absolute URLs when no backend is configured', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true, value: { origin: 'https://cockpit.example' },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'location', previous);
    else Reflect.deleteProperty(globalThis, 'location');
  });
  assert.equal(attachmentHref('https://cockpit.example/uploads/photo.png', ''), '/uploads/photo.png');
  assert.equal(attachmentHref('https://foreign.example/uploads/photo.png', ''), undefined);
  assert.equal(attachmentHref('https://cockpit.example/uploads/photo.png', 'https://backend.example'), undefined);
  assert.equal(attachmentHref('/uploads/photo.png', 'https://backend.example'),
    'https://backend.example/uploads/photo.png');
});

test('rejects schemes, authority tricks, normalization bypasses and paths outside one upload asset', () => {
  const unsafe = [
    '', ' ', '/uploads/', '/uploads', '/upload/file.png', '/private/file.png',
    'uploads/file.png', './uploads/file.png', '../uploads/file.png',
    '//foreign.example/uploads/file.png', '///foreign.example/uploads/file.png',
    'javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///uploads/file.png',
    'blob:https://backend.example/uploads/file.png', 'ftp://backend.example/uploads/file.png',
    'https:/backend.example/uploads/file.png', 'https:backend.example/uploads/file.png',
    ' /uploads/file.png', '/uploads/file.png ', '/\\foreign.example/uploads/file.png',
    '\\\\foreign.example\\uploads\\file.png', '/uploads/dir\\file.png',
    '/\n/uploads/file.png', '/uploads/fi\tle.png', '/uploads/file.png\r',
    '/uploads/\0file.png', '/uploads/file\u007f.png', '/uploads/file\u0085.png',
    '/uploads/../private', '/private/../uploads/file.png', '/uploads/./file.png',
    '/uploads/dir/file.png', '/uploads//file.png', '/uploads/.', '/uploads/..',
    '/uploads/%2e', '/uploads/.%2e', '/uploads/%2e.', '/uploads/%2E%2e',
    '/uploads/%2e%2e/private', '/uploads/%2e%2e%2fprivate', '/uploads/dir%2ffile.png',
    '/uploads/dir%2Ffile.png', '/uploads/%5cforeign.example', '/uploads/%00file.png',
    '/uploads/%0afile.png', '/uploads/%7ffile.png', '/uploads/%C2%85file.png',
    '/uploads/%252e%252e', '/uploads/%252fprivate', '/uploads/%255cprivate',
    '/uploads/%25252fprivate', '/uploads/%250afile.png',
    '/uploads/file.png?redirect=https://foreign.example', '/uploads/file.png#fragment',
    '/uploads/file%3fquery.png', '/uploads/file%23fragment.png',
    '/uploads/%', '/uploads/%zz', '/uploads/%E0%A4', '/uploads/%c0%afprivate',
    'https://backend.example/private/../uploads/file.png',
    'https://backend.example/uploads/%2e%2e/private',
    'https://backend.example\\@foreign.example/uploads/file.png',
    'https://back\nend.example/uploads/file.png',
  ];
  for (const url of unsafe) {
    assert.equal(attachmentHref(url, 'https://backend.example'), undefined, JSON.stringify(url));
  }
  for (const url of [null, undefined, 123, {}]) {
    assert.equal(attachmentHref(url as string, 'https://backend.example'), undefined);
  }
});

test('fails closed for unsafe or non-origin backend configuration', () => {
  for (const base of [
    '//backend.example', 'javascript:alert(1)', 'file:///server', 'data:text/plain,test',
    'https://user:password@backend.example', 'https://backend.example/path',
    'https://backend.example?redirect=foreign', 'https://backend.example#fragment',
    'https://back\nend.example', 'https://backend.example\\@foreign.example',
    ' https://backend.example', 'not a URL',
  ]) assert.equal(attachmentHref('/uploads/file.png', base), undefined, base);
});
