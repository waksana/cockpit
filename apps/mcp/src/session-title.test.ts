import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAuthoritativeTitle,
  resolveSessionTitle,
  type SessionTitleSource,
} from './session-title.ts';

const sessionId = '91d9b0e5-7e9a-4d43-8a6b-8b6368179568';
const sdkPromptSummary = '你是管家派出的一次性「flow-review worker」（用完即弃……）';

function source(
  live: SessionTitleSource['listLive'],
  trash: SessionTitleSource['listTrash'] = async () => [],
): SessionTitleSource {
  return { listLive: live, listTrash: trash };
}

test('live cockpit worker title wins over the SDK prompt summary', async () => {
  const authoritative = await resolveAuthoritativeTitle(
    sessionId,
    source(async () => [{ sessionId, title: '  Cockpit · flow-review worker  ' }]),
  );

  assert.equal(authoritative, 'Cockpit · flow-review worker');
  assert.equal(resolveSessionTitle(authoritative, sdkPromptSummary), 'Cockpit · flow-review worker');
});

test('trash title is used when the live title source fails', async () => {
  const authoritative = await resolveAuthoritativeTitle(
    sessionId,
    source(
      async () => {
        throw new Error('live list unavailable');
      },
      async () => [{ sessionId, title: 'Cockpit · trashed worker' }],
    ),
  );

  assert.equal(authoritative, 'Cockpit · trashed worker');
});

test('unknown sessions fall back to SDK summary and then untitled', async () => {
  const authoritative = await resolveAuthoritativeTitle(
    sessionId,
    source(
      async () => [{ sessionId: 'another-session', title: 'Another title' }],
      async () => [{ sessionId: 'trashed-session', title: 'Trashed title' }],
    ),
  );

  assert.equal(authoritative, null);
  assert.equal(resolveSessionTitle(authoritative, sdkPromptSummary), sdkPromptSummary);
  assert.equal(resolveSessionTitle(authoritative, '   '), '(untitled)');
  assert.equal(resolveSessionTitle(authoritative, null), '(untitled)');
});

test('failures from both cockpit title sources fall back instead of throwing', async () => {
  const authoritative = await resolveAuthoritativeTitle(
    sessionId,
    source(
      async () => {
        throw new Error('live list unavailable');
      },
      async () => {
        throw new Error('trash list unavailable');
      },
    ),
  );

  assert.equal(authoritative, null);
  assert.equal(resolveSessionTitle(authoritative, sdkPromptSummary), sdkPromptSummary);
});
