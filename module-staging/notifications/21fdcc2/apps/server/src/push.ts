// Durable Web Push transport, not an inbox. `accepted` is a push-service receipt,
// never evidence that a phone displayed a banner. No keys are generated at boot.
// iOS needs 16.4+, HTTPS, a Home Screen installation, and permission requested
// during a user gesture. Real lock-screen delivery still needs an iPhone check.
// Run one active writer per push directory; cut over safely before reloading keys.
import {
  closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createECDH, ECDH, randomUUID } from 'node:crypto';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import webpush from 'web-push';
import { copilotPath } from '@cockpit/core';
import {
  NotificationPayload, PushEndpoint, PushSubscriptionJson,
  type PushDelivery, type PushStatus,
} from '@cockpit/protocol';

const LEGACY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const PUSH_FILES = { config: 'vapid.json', subscriptions: 'push-subscriptions.json' } as const;
type StoreFile = typeof PUSH_FILES[keyof typeof PUSH_FILES];
const MAX_SUBSCRIPTIONS = 512;
const MAX_PAYLOAD_BYTES = 3000;
const SETUP_HELP = 'PUSH_UNCONFIGURED: call configurePush({ subject }) with a real HTTPS origin or mailto contact; COCKPIT_PUSH_SUBJECT may supply the subject.';

// All writes complete (including fsync) before returning. Implementations must
// preserve the old file on failure before commit; errors must not contain secrets.
export interface PushStorage {
  read(name: StoreFile): string | undefined;
  writeAtomic(name: StoreFile, contents: string, exclusive?: boolean): void;
}

export class FilePushStorage implements PushStorage {
  constructor(readonly root: string) {}

  read(name: StoreFile): string | undefined {
    try { return readFileSync(join(this.root, name), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('PUSH_STORAGE_READ_FAILED');
    }
  }

  writeAtomic(name: StoreFile, contents: string, exclusive = false): void {
    const staging = join(this.root, `.${name}.${randomUUID()}.pending`);
    let fd: number | undefined;
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      fd = openSync(staging, 'wx', 0o600);
      writeFileSync(fd, contents, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      if (exclusive) {
        // Unlike rename, link cannot replace a keypair concurrently configured by
        // another process. The staging file is on the same filesystem.
        linkSync(staging, join(this.root, name));
        unlinkSync(staging);
      } else {
        renameSync(staging, join(this.root, name));
      }
      if (process.platform !== 'win32') {
        fd = openSync(this.root, 'r');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
      }
    } catch {
      throw new Error('PUSH_STORAGE_WRITE_FAILED');
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(staging); } catch { /* committed, or never created */ }
    }
  }
}

interface VapidConfig { publicKey: string; privateKey: string; subject?: string }
interface StoreOptions {
  /** Push directory, default <COCKPIT_HOME>/push (COCKPIT_HOME defaults to ~/.copilot). */
  root?: string;
  /** null disables read-only legacy import; the originals are never removed. */
  legacyRoot?: string | null;
  storage?: PushStorage;
  subject?: string;
}
export type PushSender = (
  subscription: PushSubscriptionJson, payload: string, options: webpush.RequestOptions,
) => Promise<{ statusCode: number }>;
export interface PushManagerOptions extends StoreOptions {
  sender?: PushSender;
  log?: (result: PushDelivery) => void;
  now?: () => number;
  concurrency?: number;
  timeoutMs?: number;
}

// web-push owns encryption/VAPID; this small HTTP adapter also handles truncated
// responses (web-push's sendNotification can remain pending on response abort).
// A wall-clock deadline destroys the request, including DNS/connect stalls.
export function createPushSender(request: typeof https.request = https.request): PushSender {
  return async (sub, payload, options) => {
    const details = webpush.generateRequestDetails(sub, payload, options);
    return new Promise((resolve, reject) => {
      let req: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (error?: { statusCode?: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          response?.destroy();
          req?.destroy();
          reject(error);
        } else {
          resolve({ statusCode: response!.statusCode! });
        }
      };
      try {
        req = request(details.endpoint, { method: details.method, headers: details.headers }, (res) => {
          response = res;
          res.on('aborted', () => finish({}));
          res.on('error', () => finish({}));
          res.on('close', () => { if (!res.complete) finish({}); });
          res.on('end', () => {
            const code = res.statusCode ?? 0;
            finish(code >= 200 && code < 300 ? undefined : { statusCode: code });
          });
          res.resume(); // Discard response content; never retain or log it.
        });
        req.on('error', () => finish({}));
        req.on('close', () => { if (!response) finish({}); });
        timer = setTimeout(() => finish({}), Math.max(100, Math.min(30_000, options.timeout || 10_000)));
        req.end(details.body);
      } catch {
        finish({});
      }
    });
  };
}

function parseJson(raw: string, code: string): unknown {
  try {
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error();
    return JSON.parse(raw);
  } catch { throw new Error(code); }
}

function validSubject(subject: unknown): subject is string {
  if (typeof subject !== 'string' || subject.length > 2048 || /[\s\\]/.test(subject)) return false;
  try {
    const url = new URL(subject);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'mailto:') return /^[^@/?#]+@[^@/?#]+\.[^@/?#]+$/.test(url.pathname);
    return url.protocol === 'https:' && url.origin !== 'null' && url.pathname === '/';
  } catch { return false; }
}

function readConfig(raw: string): VapidConfig {
  try {
    const value = parseJson(raw, 'PUSH_CONFIG_INVALID') as VapidConfig;
    if (!value || !/^[\w-]{87}$/.test(value.publicKey) || !/^[\w-]{43}$/.test(value.privateKey)) throw new Error();
    const pair = createECDH('prime256v1');
    const privateKey = Buffer.from(value.privateKey, 'base64url');
    if (privateKey.length !== 32 || privateKey.toString('base64url') !== value.privateKey) throw new Error();
    pair.setPrivateKey(privateKey);
    if (pair.getPublicKey().toString('base64url') !== value.publicKey) throw new Error();
    if (value.subject !== undefined && !validSubject(value.subject)) throw new Error();
    return { publicKey: value.publicKey, privateKey: value.privateKey, ...(value.subject ? { subject: value.subject } : {}) };
  } catch { throw new Error('PUSH_CONFIG_INVALID: repair the stored VAPID configuration; keys were not replaced.'); }
}

function subscription(value: unknown): PushSubscriptionJson {
  try {
    const sub = PushSubscriptionJson.parse(value);
    const point = Buffer.from(sub.keys.p256dh, 'base64url');
    if (point.length !== 65 || point[0] !== 4
      || ECDH.convertKey(point, 'prime256v1').toString('base64url') !== sub.keys.p256dh) throw new Error();
    if (Buffer.from(sub.keys.auth, 'base64url').length !== 16) throw new Error();
    return sub;
  } catch { throw new Error('PUSH_SUBSCRIPTION_INVALID: HTTPS endpoint and valid p256dh/auth keys are required.'); }
}

function readSubscriptions(raw: string | undefined, publicKey: string | null): {
  publicKey: string | null; subscriptions: PushSubscriptionJson[];
} {
  if (raw === undefined) return { publicKey, subscriptions: [] };
  try {
    const value = parseJson(raw, 'PUSH_SUBSCRIPTIONS_INVALID');
    const envelope = Array.isArray(value) ? { publicKey, subscriptions: value } : value as {
      publicKey: string | null; subscriptions: unknown[];
    };
    if (!envelope || (envelope.publicKey !== null && typeof envelope.publicKey !== 'string')
      || !Array.isArray(envelope.subscriptions) || envelope.subscriptions.length > MAX_SUBSCRIPTIONS) throw new Error();
    return { publicKey: envelope.publicKey, subscriptions: envelope.subscriptions.map(subscription) };
  } catch { throw new Error('PUSH_SUBSCRIPTIONS_INVALID: repair the subscription store; it was not overwritten.'); }
}

function stores(options: StoreOptions): { store: PushStorage; legacy?: PushStorage } {
  return {
    store: options.storage ?? new FilePushStorage(options.root ?? copilotPath('push')),
    // Injected stores/roots are isolated unless legacy import is explicitly asked
    // for. This keeps synthetic tests and side-by-side instances off live data.
    legacy: options.legacyRoot === null || (options.legacyRoot === undefined && (options.storage || options.root))
      ? undefined : new FilePushStorage(options.legacyRoot ?? LEGACY_ROOT),
  };
}

function load(options: StoreOptions) {
  const { store, legacy } = stores(options);
  const ownConfig = store.read(PUSH_FILES.config);
  const ownSubs = store.read(PUSH_FILES.subscriptions);
  const configRaw = ownConfig ?? legacy?.read(PUSH_FILES.config);
  const config = configRaw === undefined ? undefined : readConfig(configRaw);
  const legacySubs = ownSubs === undefined ? legacy?.read(PUSH_FILES.subscriptions) : undefined;
  // An old array has no key binding. Bind legacy subscriptions to their ORIGINAL
  // config, never to an unrelated key already present in the new directory.
  const legacyConfig = legacySubs === undefined ? undefined : legacy?.read(PUSH_FILES.config);
  const binding = legacySubs === undefined ? config?.publicKey : legacyConfig === undefined
    ? undefined : readConfig(legacyConfig).publicKey;
  const subs = readSubscriptions(ownSubs ?? legacySubs, binding ?? null);
  // Validate BOTH files before migrating either; never regenerate on corruption.
  if (ownConfig === undefined && config) store.writeAtomic(PUSH_FILES.config, JSON.stringify(config), true);
  if (ownSubs === undefined && legacySubs !== undefined) {
    store.writeAtomic(PUSH_FILES.subscriptions, JSON.stringify(subs), true);
  }
  return { store, config, subs };
}

/**
 * Explicit, idempotent operator setup; never called by server boot.
 * From apps/server, with a known public subject supplied by the operator:
 * node --import tsx --input-type=module -e
 * 'import {configurePush} from "./src/push.ts"; configurePush({subject:process.env.COCKPIT_PUSH_SUBJECT});'
 * Stores <COCKPIT_HOME>/push/{vapid.json,push-subscriptions.json}; no secret stdout.
 * Existing/legacy keys are retained; corruption or lost keys with subscriptions
 * fail closed. A running manager must be safely reloaded after configuration.
 */
export function configurePush(options: StoreOptions = {}): { configured: true; publicKey: string } {
  const { store, config, subs } = load(options);
  const subject = options.subject ?? process.env.COCKPIT_PUSH_SUBJECT ?? config?.subject;
  if (!validSubject(subject)) throw new Error('PUSH_SUBJECT_REQUIRED: supply a real HTTPS origin or mailto contact.');
  if (!config && subs.subscriptions.length) throw new Error('PUSH_KEYS_MISSING_WITH_SUBSCRIPTIONS: restore the original VAPID keys.');
  if (config && subs.subscriptions.length && subs.publicKey !== config.publicKey) {
    throw new Error('PUSH_KEYS_CHANGED: subscriptions belong to another VAPID key; restore that key or explicitly unsubscribe.');
  }
  const next = { ...(config ?? webpush.generateVAPIDKeys()), subject };
  if (!config || config.subject !== subject) {
    store.writeAtomic(PUSH_FILES.config, JSON.stringify(next), !config);
  }
  return { configured: true, publicKey: next.publicKey };
}

function clip(text: string, bytes: number): string {
  let result = '';
  for (const character of text) {
    bytes -= Buffer.byteLength(character);
    if (bytes < 0) break;
    result += character;
  }
  return result;
}

export class PushManager {
  private readonly store: PushStorage;
  private config?: VapidConfig;
  private subject?: string;
  private subs = new Map<string, PushSubscriptionJson>();
  private subscriptionKey: string | null = null;
  private initializationError?: string;
  private storageError?: string;
  private lastDelivery?: PushDelivery;
  private deliveries = new Map<string, PushDelivery>();
  private readonly sender: PushSender;
  private readonly log: (result: PushDelivery) => void;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(options: PushManagerOptions = {}) {
    this.store = stores(options).store;
    this.sender = options.sender ?? createPushSender();
    this.log = options.log ?? ((result) => console.error('Web Push', result));
    this.now = options.now ?? Date.now;
    this.concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency || 4)));
    this.timeoutMs = Math.max(100, Math.min(30_000, options.timeoutMs || 10_000));
    try {
      const { config, subs } = load({ ...options, storage: this.store,
        legacyRoot: options.legacyRoot !== undefined ? options.legacyRoot : (options.root || options.storage ? null : LEGACY_ROOT) });
      this.config = config;
      this.subject = options.subject ?? process.env.COCKPIT_PUSH_SUBJECT ?? config?.subject;
      this.subs = new Map(subs.subscriptions.map((sub) => [sub.endpoint, sub]));
      this.subscriptionKey = subs.publicKey;
    } catch (error) {
      this.initializationError = safeStorageError(error);
      this.record('failed', this.initializationError);
    }
  }

  get publicKey(): string | null { return this.status().publicKey; }

  private configurationError(): string | undefined {
    if (this.initializationError) return this.initializationError;
    // Detect live edits/deletion too: do not acknowledge new registrations using
    // a cached key that no longer matches durable configuration.
    try {
      const raw = this.store.read(PUSH_FILES.config);
      const current = raw === undefined ? undefined : readConfig(raw);
      if (current?.publicKey !== this.config?.publicKey || current?.privateKey !== this.config?.privateKey
        || current?.subject !== this.config?.subject) return 'PUSH_CONFIG_CHANGED: safely reload the transport; changed keys require browser re-subscription.';
    } catch (error) { return safeStorageError(error); }
    if (!this.config) return SETUP_HELP;
    if (!validSubject(this.subject)) return 'PUSH_SUBJECT_REQUIRED: set COCKPIT_PUSH_SUBJECT or call configurePush({ subject }).';
    if (this.subs.size && this.subscriptionKey !== this.config.publicKey) {
      return 'PUSH_KEYS_CHANGED: restore the original VAPID key or explicitly unsubscribe stale registrations.';
    }
    return undefined;
  }

  status(endpoint?: string): PushStatus {
    const configError = this.configurationError();
    const error = configError ?? this.storageError;
    const lastDelivery = endpoint === undefined ? this.lastDelivery : this.deliveries.get(endpoint);
    return {
      configured: !error,
      ...(endpoint !== undefined ? { registered: !configError && this.subs.has(endpoint) } : {}),
      subscriptionCount: this.subs.size,
      publicKey: configError ? null : this.config?.publicKey ?? null,
      ...(lastDelivery ? { lastDelivery: { ...lastDelivery } } : {}),
      ...(error ? { error } : {}),
    };
  }

  private persist(next: Map<string, PushSubscriptionJson>, key = this.config?.publicKey ?? null): void {
    try {
      this.store.writeAtomic(PUSH_FILES.subscriptions, JSON.stringify({ publicKey: key, subscriptions: [...next.values()] }));
      this.subs = next;
      this.subscriptionKey = key;
      this.storageError = undefined;
    } catch {
      this.storageError = 'PUSH_STORAGE_WRITE_FAILED: registration changes were not acknowledged; check the push directory permissions and disk.';
      this.record('failed', this.storageError);
      throw new Error(this.storageError);
    }
  }

  subscribe(value: PushSubscriptionJson): void {
    const sub = subscription(value);
    const error = this.configurationError();
    if (error) throw new Error(error);
    if (!this.subs.has(sub.endpoint) && this.subs.size >= MAX_SUBSCRIPTIONS) throw new Error('PUSH_SUBSCRIPTION_LIMIT');
    const next = new Map(this.subs);
    next.set(sub.endpoint, sub);
    this.persist(next);
  }

  unsubscribe(endpoint: string): void {
    if (!PushEndpoint.safeParse(endpoint).success) throw new Error('PUSH_ENDPOINT_INVALID');
    if (this.initializationError) throw new Error(this.initializationError);
    const next = new Map(this.subs);
    next.delete(endpoint);
    // Preserve the old key binding until every old registration was removed.
    this.persist(next, next.size ? this.subscriptionKey : this.config?.publicKey ?? null);
    this.deliveries.delete(endpoint);
  }

  async test(endpoint: string, confirm: boolean): Promise<PushDelivery> {
    if (confirm !== true) return this.record('failed', 'PUSH_TEST_CONFIRM_REQUIRED');
    if (!PushEndpoint.safeParse(endpoint).success) return this.record('failed', 'PUSH_ENDPOINT_INVALID');
    const sub = this.subs.get(endpoint);
    if (!sub) return this.record('failed', 'PUSH_NOT_REGISTERED', endpoint);
    return this.deliver(sub, JSON.stringify({
      type: 'notification', kind: 'test', title: '推送测试',
      body: '这是一条你主动请求的通知测试，不会增加未读消息。',
      tag: 'cockpit-push-test', url: '/',
    } satisfies NotificationPayload));
  }

  async sendAttention(
    title: string, sessionId: string, kind: 'ready' | 'choice', body: string,
    unreadCount?: number, metadata?: { attnId?: number; inboxRevision?: number },
  ): Promise<void> {
    try {
      const payload = NotificationPayload.parse({
        type: 'notification', kind,
        title: `${kind === 'choice' ? '需要选择' : '新回复'} · ${clip(title, 192)}`,
        body: clip(body, 1200), sessionId, tag: sessionId,
        url: `/session/${encodeURIComponent(sessionId)}`,
        ...(unreadCount !== undefined ? { unreadCount, badge: unreadCount } : {}),
        ...metadata,
      });
      const json = JSON.stringify(payload);
      if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) throw new Error();
      const error = this.configurationError();
      if (error) { this.record('failed', error); return; }
      const pending = [...this.subs.values()][Symbol.iterator]();
      await Promise.all(Array.from({ length: Math.min(this.concurrency, this.subs.size) }, async () => {
        for (const sub of pending) await this.deliver(sub, json);
      }));
    } catch {
      this.record('failed', 'PUSH_PAYLOAD_INVALID: notification exceeds transport bounds or has invalid metadata.');
    }
  }

  private record(status: PushDelivery['status'], error?: string, endpoint?: string): PushDelivery {
    const result: PushDelivery = { status, at: this.now(), ...(error ? { error } : {}) };
    this.lastDelivery = result;
    if (endpoint !== undefined) {
      this.deliveries.delete(endpoint);
      this.deliveries.set(endpoint, result);
      if (this.deliveries.size > MAX_SUBSCRIPTIONS) this.deliveries.delete(this.deliveries.keys().next().value!);
    }
    if (status !== 'accepted') {
      try { this.log({ ...result }); } catch { /* a logger must not break chat */ }
    }
    return { ...result };
  }

  private async deliver(sub: PushSubscriptionJson, payload: string): Promise<PushDelivery> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= 64) return this.record('failed', 'PUSH_BUSY: bounded transport capacity reached.', sub.endpoint);
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else { this.active++; }
    try {
      const error = this.configurationError();
      if (error) return this.record('failed', error, sub.endpoint);
      // A queued send must not revive a registration removed while it waited.
      if (this.subs.get(sub.endpoint) !== sub) return this.record('failed', 'PUSH_REGISTRATION_CHANGED', sub.endpoint);
      try {
        const result = await this.sender(sub, payload, {
          vapidDetails: { ...this.config!, subject: this.subject! },
          timeout: this.timeoutMs, TTL: 300, urgency: 'high',
        });
        if (result.statusCode < 200 || result.statusCode >= 300 || !Number.isInteger(result.statusCode)) throw { statusCode: result.statusCode };
        return this.record('accepted', undefined, sub.endpoint);
      } catch (error) {
        const code = (error as { statusCode?: unknown } | null)?.statusCode;
        if (code === 404 || code === 410) {
          if (this.subs.get(sub.endpoint) === sub) {
            const next = new Map(this.subs);
            next.delete(sub.endpoint);
            try { this.persist(next); }
            catch { return this.record('failed', 'PUSH_EXPIRED_CLEANUP_FAILED: expired registration could not be durably removed.', sub.endpoint); }
          }
          return this.record('expired', `PUSH_HTTP_${code}: registration expired.`, sub.endpoint);
        }
        return this.record('failed', typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599
          ? `PUSH_HTTP_${code}` : 'PUSH_TRANSPORT_FAILED: request failed or timed out.', sub.endpoint);
      }
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

// Do not pass fs errors, JSON parser errors, web-push response bodies, or causes to
// the logger/API: they can contain paths, subscription URLs and private key data.
function safeStorageError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  for (const code of ['PUSH_CONFIG_INVALID', 'PUSH_SUBSCRIPTIONS_INVALID', 'PUSH_STORAGE_READ_FAILED', 'PUSH_STORAGE_WRITE_FAILED']) {
    if (message.startsWith(code)) return code;
  }
  return 'PUSH_STORAGE_READ_FAILED';
}
