import { ModuleDiagnosticHistory } from '@cockpit/protocol';

// One bootstrap observation, not an event archive. Dismissal never changes backend history.
export class ModuleDiagnostics {
  private snapshot: ModuleDiagnosticHistory & { dismissed: boolean } = { errors: [], dismissed: false };
  private signature = '';
  private readonly listeners = new Set<() => void>();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  replace(value: unknown): void {
    const history = ModuleDiagnosticHistory.parse(value);
    const signature = JSON.stringify(history);
    if (signature === this.signature) return;
    this.signature = signature;
    this.snapshot = { ...history, dismissed: false };
    for (const listener of this.listeners) listener();
  }
  dismiss = (): void => {
    if (this.snapshot.dismissed) return;
    this.snapshot = { ...this.snapshot, dismissed: true };
    for (const listener of this.listeners) listener();
  };
}
