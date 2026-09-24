// Real-DOM interaction tests: import this module first in the test file.
// It registers happy-dom (see ./happyDom) and then loads Testing Library,
// whose `screen` binds to the global document at import time.
import './happyDom';
import { afterEach } from 'node:test';
import { cleanup } from '@testing-library/react';

export { window, DOM_URL } from './happyDom';
export * from '@testing-library/react';
export { default as userEvent } from '@testing-library/user-event';

// node:test has no global afterEach, so Testing Library cannot register its own.
afterEach(() => { cleanup(); });
