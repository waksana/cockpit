import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle, Button } from '@cockpit/ui';
import { describeReason, reportUxError } from '../lib/errorReporter';

export function EntryFailure({ reason }: { reason: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 p-6">
      <Alert variant="destructive">
        <AlertTitle>新界面暂时无法显示</AlertTitle>
        <AlertDescription className="whitespace-pre-wrap break-words">{reason}</AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => window.location.reload()}>重新载入</Button>
        <Button asChild variant="outline"><a href="/">打开经典界面</a></Button>
      </div>
    </main>
  );
}

export class EntryBoundary extends Component<{ children: ReactNode }, { reason: string | null }> {
  state: { reason: string | null } = { reason: null };

  static getDerivedStateFromError(error: unknown) {
    return { reason: describeReason(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportUxError(`新界面渲染失败：${describeReason(error)}${info.componentStack ?? ''}`);
  }

  render() {
    return this.state.reason === null ? this.props.children : <EntryFailure reason={this.state.reason} />;
  }
}
