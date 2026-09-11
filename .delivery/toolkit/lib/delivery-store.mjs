import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { validateRequest, validateResult } from './contracts.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const terminal = row => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(row.result.state)
  || (row.request.intent === 'build-only' && row.result.state === 'built');
export function fault(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

export class DeliveryStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, serial INTEGER UNIQUE NOT NULL, body TEXT NOT NULL,
        body_hash TEXT NOT NULL, actor TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, body TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id) {
    const row = this.db.prepare('SELECT record FROM requests WHERE id=?').get(id);
    return row ? JSON.parse(row.record) : null;
  }
  rows() { return this.db.prepare('SELECT record FROM requests ORDER BY serial').all().map(row => JSON.parse(row.record)); }
  setting(id) {
    const row = this.db.prepare('SELECT body FROM settings WHERE id=?').get(id);
    return row ? JSON.parse(row.body) : null;
  }
  set(id, value) {
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(id, JSON.stringify(value));
  }
  approve(authorization) {
    const old = this.db.prepare('SELECT body,revoked FROM approvals WHERE id=?').get(authorization.reference);
    if (old) {
      if (old.body !== canonical(authorization) || old.revoked) throw fault('APPROVAL_CONFLICT', 'Approval identity is bound differently or revoked');
      return;
    }
    this.db.prepare('INSERT INTO approvals(id,body) VALUES (?,?)').run(authorization.reference, canonical(authorization));
  }
  revoke(reference) {
    if (!this.db.prepare('UPDATE approvals SET revoked=1 WHERE id=?').run(reference).changes) throw fault('NOT_FOUND', 'Approval absent', 404);
  }
  checkApproval(request) {
    if (request.intent === 'build-only') return;
    const a = request.authorization;
    const row = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(a.reference);
    if (!row || row.revoked || row.body !== canonical(a) || Date.parse(a.expiresAt) <= Date.now()) {
      throw fault('APPROVAL_INVALID', 'Approval is absent, revoked, expired or differently bound', 403);
    }
  }
  existing(request, actor) {
    const row = this.get(request.requestId);
    if (!row) return null;
    if (row.actor !== actor || row.bodyHash !== digest(canonical(request))) throw fault('REQUEST_CONFLICT', 'Request identity already binds different input or actor');
    return row;
  }
  accept(request, actor, project) {
    return this.transaction(() => {
      const existing = this.existing(request, actor);
      if (existing) return existing;
      validateRequest(request);
      this.checkApproval(request);
      const serial = this.db.prepare('SELECT COALESCE(MAX(serial),0)+1 AS n FROM requests').get().n;
      const result = { schemaVersion: 1, requestId: request.requestId, repoId: request.repo.id,
        requestedSha: request.repo.sha, configSha256: request.projectConfig.sha256,
        environment: request.environment, sequence: 1, updatedAt: new Date().toISOString(), state: 'queued',
        artifact: null, running: null, health: null, failure: null, recovery: null };
      const row = { request, actor, project, serial, bodyHash: digest(canonical(request)), result,
        createdAt: Date.now(), notificationAttempted: false };
      this.db.prepare('INSERT INTO requests VALUES (?,?,?,?,?,?)')
        .run(request.requestId, serial, canonical(request), row.bodyHash, actor, JSON.stringify(row));
      return row;
    });
  }
  save(row) {
    const current = this.get(row.request.requestId);
    if (!current || current.result.sequence !== row.result.sequence) throw fault('STALE_WRITE', 'Delivery state changed');
    row.result.sequence++;
    row.result.updatedAt = new Date().toISOString();
    validateResult(row.request, row.result);
    this.db.prepare('UPDATE requests SET record=? WHERE id=?').run(JSON.stringify(row), row.request.requestId);
    return row;
  }
  fail(row, stage, error, effects = 'not-applied') {
    row.result.state = effects === 'unknown' ? 'unknown' : 'failed';
    row.result.failure = { stage, code: typeof error.code === 'string' ? error.code : 'DELIVERY_FAILED',
      message: error.message, effects };
    row.result.recovery = row.request.intent === 'deploy'
      ? { state: effects === 'not-applied' ? 'not-needed' : 'unknown', reference: `request:${row.request.requestId}`, runningSha: null } : null;
    return this.save(row);
  }
  recordRuntime(row, evidence, { reconciled = false } = {}) {
    return this.transaction(() => {
      row.result.running = evidence.running;
      row.result.health = evidence.health;
      if (reconciled) {
        row.result.state = 'failed';
        row.result.failure.effects = 'applied';
        row.result.recovery = { state: 'not-needed', reference: 'explicit-process-reconciliation',
          runningSha: evidence.running.sha };
      } else row.result.state = 'succeeded';
      this.save(row);
      const key = `${row.request.repo.id}:${row.request.environment}`;
      this.set(`active:${key}`, { root: row.releaseRoot, sha: row.request.repo.sha,
        artifactSha256: row.result.artifact.sha256, requestId: row.request.requestId });
      this.set(`watermark:${key}`, row.request.repo.sha);
      return row;
    });
  }
  head(projectId, environment) {
    return this.rows().find(row => row.request.intent === 'deploy' && row.request.repo.id === projectId
      && row.request.environment === environment && (!terminal(row) || row.result.state === 'unknown'
        || ['pending', 'unknown', 'failed'].includes(row.result.recovery?.state)));
  }
  claim(id, deadlineMs) {
    return this.transaction(() => {
      const row = this.get(id);
      if (!row || this.head(row.request.repo.id, row.request.environment)?.request.requestId !== id
        || row.result.state !== 'built') throw fault('NOT_HEAD', 'Only the built deployment queue head can claim');
      this.checkApproval(row.request);
      row.fence = randomBytes(24).toString('hex');
      row.deadline = Date.now() + deadlineMs;
      row.result.state = 'waiting-idle';
      return this.save(row);
    });
  }
  activate(id, fence) {
    return this.transaction(() => {
      const row = this.get(id);
      if (!row || row.fence !== fence || row.result.state !== 'waiting-idle'
        || row.deadline <= Date.now()
        || this.head(row.request.repo.id, row.request.environment)?.request.requestId !== id) {
        throw fault('STALE_FENCE', 'Activation claim is stale, expired or no longer queue head');
      }
      this.checkApproval(row.request);
      row.result.state = 'activating';
      return this.save(row);
    });
  }
  close() { this.db.close(); }
}
