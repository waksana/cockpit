import http, { type IncomingHttpHeaders, type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import assert from 'node:assert/strict';

export const MOCK_ORIGIN = 'http://mcp-backend.invalid:8771';
export interface ReceivedRequest {
  url: string;
  method: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export class MockResponse extends EventEmitter {
  private readonly stream = new PassThrough();
  private readonly headers: Record<string, string> = {};
  private status = 200;
  private sent = false;

  constructor(
    private readonly deliver: (response: IncomingMessage) => void,
    private readonly fail: (error: Error) => void,
  ) {
    super();
    this.stream.on('error', () => {});
    this.stream.once('close', () => this.emit('close'));
  }

  setHeader(name: string, value: string | number): this {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  }

  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.status = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }

  flushHeaders(): void {
    if (this.sent) return;
    this.sent = true;
    this.deliver(Object.assign(this.stream, {
      statusCode: this.status,
      statusMessage: http.STATUS_CODES[this.status],
      headers: this.headers,
      rawHeaders: Object.entries(this.headers).flat(),
    }) as unknown as IncomingMessage);
  }

  write(body: string | Uint8Array): void {
    this.flushHeaders();
    setImmediate(() => { if (!this.stream.destroyed) this.stream.write(body); });
  }

  end(body?: string | Uint8Array): void {
    this.flushHeaders();
    setImmediate(() => { if (!this.stream.destroyed) this.stream.end(body); });
  }

  destroy(error = new Error(this.sent ? 'response connection reset' : 'socket hang up')): void {
    if (this.stream.destroyed) return;
    if (!this.sent) this.fail(error);
    this.stream.pause();
    this.stream.destroy(error);
  }
}

// Install before importing any client module: exercise the real transport/body
// reader without opening sockets, listening, or consulting operator configuration.
export function mockHttp(
  respond: (response: MockResponse, request: ReceivedRequest) => void,
  onWrite?: (chunk: Buffer) => void | Promise<void>,
): void {
  process.env.COCKPIT_URL = MOCK_ORIGIN;
  process.env.COCKPIT_PORT = '8771';
  delete process.env.COCKPIT_API_TOKEN;
  delete process.env.COCKPIT_TIMEOUT_MS;
  const send = (target: URL, options: RequestOptions, deliver: (response: IncomingMessage) => void) => {
    assert.equal(target.origin, MOCK_ORIGIN, 'unexpected network origin');
    const chunks: Buffer[] = [];
    const request = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        Promise.resolve().then(() => onWrite?.(chunk)).then(() => callback(), callback);
      },
      final(callback) {
        queueMicrotask(() => respond(response, {
          url: target.pathname + target.search,
          method: options.method,
          headers: options.headers as IncomingHttpHeaders,
          body: Buffer.concat(chunks),
        }));
        callback();
      },
    });
    const response = new MockResponse(deliver, (error) => request.emit('error', error));
    const keepAlive = setInterval(() => {}, 60_000);
    options.signal?.addEventListener('abort', () => {
      clearInterval(keepAlive);
      response.destroy(new Error('mock request aborted'));
      request.destroy();
    }, { once: true });
    return request;
  };
  mock.method(http, 'request', send);
  mock.method(https, 'request', send);
  const noNetwork = () => { throw new Error('Live networking is forbidden in MCP tests'); };
  mock.method(http, 'get', noNetwork);
  mock.method(https, 'get', noNetwork);
  mock.method(net.Socket.prototype, 'connect', noNetwork);
  mock.method(net.Server.prototype, 'listen', noNetwork);
  mock.method(globalThis, 'fetch', noNetwork);
  syncBuiltinESMExports();
}
