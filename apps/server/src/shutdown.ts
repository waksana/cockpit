import type { ServiceShutdown } from '@cockpit/protocol';

interface Dependencies {
  busyCount(): Promise<number>;
  stopNative(): Promise<void>;
  closeTransport(): Promise<void>;
  exit(code: number): void;
  report(error: unknown, stage: string): void;
  delayMs?: number;
}

export class GracefulShutdown {
  private state: ServiceShutdown = { phase: 'running', requestedAt: null, error: null };
  private retained = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private checking?: Promise<void>;
  private closing?: Promise<void>;
  private dirty = false;
  private disposed = false;
  private nativeFailed = false;

  constructor(private readonly dependencies: Dependencies) {}

  snapshot(): ServiceShutdown { return { ...this.state }; }
  get inFlightRequests(): number { return this.retained; }

  request(): ServiceShutdown {
    if (this.state.phase === 'failed') throw new Error(this.state.error ?? 'Service shutdown failed');
    if (this.disposed || this.state.phase === 'closed') throw new Error('Service is closed');
    if (this.state.phase === 'running') {
      this.state = { phase: 'waiting', requestedAt: Date.now(), error: null };
    }
    this.notify();
    return this.snapshot();
  }

  retain(): () => void {
    if (this.disposed || !['running', 'waiting'].includes(this.state.phase)) throw new Error('Service is closing');
    this.retained++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retained--;
      this.notify();
    };
  }

  notify(): void {
    if (this.disposed || this.state.phase !== 'waiting') return;
    if (this.checking) { this.dirty = true; return; }
    this.dirty = false;
    this.checking = this.check().catch(error => {
      this.record(error, 'shutdown safety');
    }).finally(() => {
      this.checking = undefined;
      if (this.dirty) this.notify();
    });
  }

  private async check(): Promise<void> {
    if (this.retained) { this.clearTimer(); return; }
    const busy = await this.readBusy();
    if (this.disposed || this.state.phase !== 'waiting') return;
    this.state.error = null;
    if (busy || this.retained) { this.clearTimer(); return; }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.finishWhenIdle().catch(error => { this.record(error, 'shutdown safety'); });
    }, this.dependencies.delayMs ?? 500);
  }

  private async finishWhenIdle(): Promise<void> {
    if (this.disposed || this.state.phase !== 'waiting' || this.retained) return;
    const busy = await this.readBusy();
    if (this.disposed || this.state.phase !== 'waiting' || this.retained || busy) return;
    this.beginClose();
  }

  private beginClose(): void {
    this.clearTimer();
    if (this.closing) return;
    this.state.phase = 'closing';
    this.closing = this.finish().catch(error => {
      this.record(error, 'process exit');
      this.state.phase = 'failed';
    }).finally(() => {
      this.closing = undefined;
      if (this.state.phase === 'waiting') this.notify();
    });
  }

  private async finish(): Promise<void> {
    try {
      await this.dependencies.stopNative();
    } catch (error) {
      if (!this.nativeFailed && error && typeof error === 'object' && 'code' in error && error.code === 'SESSION_BUSY') {
        this.state.phase = 'waiting';
        return;
      }
      this.record(error, 'native shutdown');
      if (!this.nativeFailed) { this.state.phase = 'failed'; return; }
    }
    try {
      await this.dependencies.closeTransport();
    } catch (error) {
      this.record(error, 'transport shutdown');
      if (!this.nativeFailed) { this.state.phase = 'failed'; return; }
    }
    this.state.phase = 'closed';
    this.dependencies.exit(this.nativeFailed ? 1 : 0);
  }

  runtimeFailed(error: Error): void {
    if (this.disposed || this.state.phase === 'closed') return;
    this.nativeFailed = true;
    this.record(error, 'native runtime failure');
    this.beginClose();
  }

  private async readBusy(): Promise<number> {
    const busy = await this.dependencies.busyCount();
    if (!Number.isSafeInteger(busy) || busy < 0) throw new Error('Native safety count is invalid');
    return busy;
  }

  private record(error: unknown, stage: string): void {
    this.state.error = error instanceof Error ? error.message : String(error);
    this.dependencies.report(error, stage);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }
}
