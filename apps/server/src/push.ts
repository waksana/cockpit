// Web Push (VAPID). Sends a notification to the user's device(s) when a session
// finishes a turn (running -> idle), so the phone alerts even with the screen
// off — a page-context Notification can't do that; only a service worker woken
// by a push can. iOS requires the site be installed as a PWA. The VAPID keypair
// and subscriptions persist to JSON files under apps/server/data (no DB).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import webpush from 'web-push';
import type { PushSubscriptionJson } from '@cockpit/protocol';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const VAPID_FILE = join(DATA, 'vapid.json');
const SUBS_FILE = join(DATA, 'push-subscriptions.json');

export class PushManager {
  publicKey: string | null = null;
  private subs = new Map<string, PushSubscriptionJson>();

  constructor() {
    try {
      const vapid = JSON.parse(readFileSync(VAPID_FILE, 'utf-8')) as { publicKey: string; privateKey: string };
      webpush.setVapidDetails('mailto:push@cockpit.rbym47.com', vapid.publicKey, vapid.privateKey);
      this.publicKey = vapid.publicKey;
    } catch { this.publicKey = null; }
    this.loadSubs();
  }

  private loadSubs(): void {
    if (!existsSync(SUBS_FILE)) return;
    try {
      const arr = JSON.parse(readFileSync(SUBS_FILE, 'utf-8')) as PushSubscriptionJson[];
      for (const s of arr) if (s.endpoint) this.subs.set(s.endpoint, s);
    } catch { /* ignore */ }
  }

  private saveSubs(): void {
    try { writeFileSync(SUBS_FILE, JSON.stringify([...this.subs.values()], null, 2)); } catch { /* ignore */ }
  }

  subscribe(sub: PushSubscriptionJson): void {
    if (!sub.endpoint) return;
    this.subs.set(sub.endpoint, sub);
    this.saveSubs();
  }

  // Push a session's raised attention to every subscribed device. `kind` ('ready'
  // | 'choice') comes from the Engine's authoritative signal; the tag is keyed by
  // session alone so an escalation (ready → choice) REPLACES the session's existing
  // banner rather than stacking a second one. `badge` is the global count of
  // sessions awaiting the user, so the SW can set the app-icon badge even while the
  // screen is off.
  async sendAttention(title: string, sessionId: string, kind: string, body: string, badge?: number): Promise<void> {
    await this.send({
      title,
      body: body.slice(0, 140),
      tag: sessionId,
      url: `/session/${sessionId}`,
      sessionId,
      kind,
      ...(typeof badge === 'number' ? { badge } : {}),
    });
  }

  private async send(payloadObj: { title: string; body: string; tag: string; url: string; sessionId: string; kind: string; badge?: number }): Promise<void> {
    if (!this.publicKey || this.subs.size === 0) return;
    const payload = JSON.stringify(payloadObj);
    const dead: string[] = [];
    await Promise.all([...this.subs.values()].map(async (sub) => {
      try { await webpush.sendNotification(sub as unknown as webpush.PushSubscription, payload); }
      catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(sub.endpoint);
      }
    }));
    if (dead.length) { for (const ep of dead) this.subs.delete(ep); this.saveSubs(); }
  }
}
