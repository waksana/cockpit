import { mockHttp } from './mock-http.ts';
mockHttp(() => { throw new Error('Unexpected request during registry-only smoke test'); });
