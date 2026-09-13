import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasTransferFiles, transferFiles } from './attachmentInput';

function transfer(files: File[], items: Partial<DataTransferItem>[] = files.map(file => ({
  kind: 'file', getAsFile: () => file,
}))) {
  return {
    items: items as unknown as DataTransferItemList,
    files: files as unknown as FileList,
    types: files.length || items.some(item => item.kind === 'file') ? ['Files'] : ['text/plain'],
  };
}

test('items win over duplicate files without deduplicating deliberate equal files', () => {
  const a = new File(['same'], 'same.txt');
  const b = new File(['same'], 'same.txt');
  const data = transfer([a, b]);
  assert.equal(hasTransferFiles(data), true);
  assert.deepEqual(transferFiles(data), [a, b]);
  assert.equal(transferFiles(data)[1], b);
});

test('files-only clipboard/drop payloads and null-item fallback preserve order', () => {
  const files = [new File(['image'], 'x.png'), new File(['video'], 'x.mp4')];
  assert.deepEqual(transferFiles(transfer(files, [])), files);
  assert.deepEqual(transferFiles(transfer(files, [{ kind: 'file', getAsFile: () => null }])), files);
});

test('text, HTML, file paths and URLs without binary data never become uploads', () => {
  const data = transfer([], [{ kind: 'string', type: 'text/html' }]);
  assert.equal(hasTransferFiles(data), false);
  assert.deepEqual(transferFiles(data), []);
});

test('directories and partially unreadable batches fail explicitly without scanning', () => {
  const file = new File(['x'], 'x.txt');
  assert.throws(() => transferFiles(transfer([file], [{
    kind: 'file', getAsFile: () => file,
    webkitGetAsEntry: () => ({ isDirectory: true }) as FileSystemEntry,
  }])), /目录/);
  assert.throws(() => transferFiles(transfer([], [{ kind: 'file', getAsFile: () => null }])), /未提供可读取/);
});
