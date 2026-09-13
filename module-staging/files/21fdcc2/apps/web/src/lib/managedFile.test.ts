import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileDownloadUrl, filePreview, filesBrowseUrl, managedUploadPath } from './managedFile';

test('only supported raster/SVG images and native video formats receive previews', () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']) {
    assert.equal(filePreview({ mime }), 'image');
  }
  for (const mime of ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']) {
    assert.equal(filePreview({ mime }), 'video');
  }
  assert.equal(filePreview({ mime: 'IMAGE/PNG; charset=binary' }), 'image');
  for (const mime of ['image/tiff', 'image/heic', 'image/x-unknown', 'text/html', 'application/pdf', 'text/plain', undefined]) {
    assert.equal(filePreview({ mime }), undefined);
  }
});

test('managed downloads use original bytes and safe same-origin URLs', () => {
  assert.equal(fileDownloadUrl('/uploads/recording.mp4'), '/uploads/recording.mp4?download=1');
  assert.equal(managedUploadPath('/uploads/recording.mp4'), '/uploads/recording.mp4');
  assert.equal(managedUploadPath('/uploads/recording.mp4?download=1'), '/uploads/recording.mp4');
  assert.equal(filesBrowseUrl('/uploads/recording.mp4', 'a/b'), '/files?url=%2Fuploads%2Frecording.mp4&sessionId=a%2Fb');
  for (const url of ['https://external.example/uploads/x', '//external.example/x', '/uploads/../private', '/uploads/x?download=0', 'data:text/html,bad']) {
    assert.equal(fileDownloadUrl(url), undefined);
    assert.equal(managedUploadPath(url), undefined);
  }
});
