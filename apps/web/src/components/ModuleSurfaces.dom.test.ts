import { render, screen } from '../test/dom';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { fixtureSession } from '../dev/chat-fixtures';
import { useCockpit } from '../net/store';
import { Thread } from './Thread';

function withConnectedStore(t: TestContext) {
  const previous = useCockpit.getState();
  useCockpit.setState({ ...previous, connState: 'open', snapshotReady: true }, true);
  t.after(() => { useCockpit.setState(previous, true); });
}

test('thread renders message content directly without module placeholder observers or notifications', t => {
  withConnectedStore(t);
  let intersectionConstructed = 0;
  class FakeIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: ReadonlyArray<number> = [];
    disconnect(): void {}
    observe(): void { intersectionConstructed++; }
    takeRecords(): IntersectionObserverEntry[] { return []; }
    unobserve(): void {}
  }
  t.mock.method(window, 'IntersectionObserver', FakeIntersectionObserver);
  const localStorageCalls: string[] = [];
  t.mock.method(window.localStorage, 'getItem', (key: string) => {
    localStorageCalls.push(key);
    return null;
  });

  const session = fixtureSession('reading');
  render(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));

  assert.ok(screen.getByText('优先保证清晰和稳定。'));
  assert.ok(screen.getByRole('heading', { name: '阅读优先，过程有序' }));
  assert.equal(intersectionConstructed, 0);
  assert.equal(localStorageCalls.length, 0);
  assert.equal(document.querySelector('[data-unread], [data-notification], .notification'), null);
});
