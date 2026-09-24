// Render-crash boundaries (docs/frontend-guidelines.md#error-boundaries).
// ErrorBoundary is the ownerless last resort around the whole App: it reports
// through the global local notice and offers a page reload. RegionErrorBoundary
// owns one region's failure: it shows it in place with a local retry, keeps a
// console record and leaves the global notice silent.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { copy } from '../lib/copy';
import { describeReason, recordUxDiagnostic, reportUxError } from '../lib/errorReporter';
import { Button } from './Button';
import { OperationResult } from './OperationResult';

function renderCrashText(error: unknown, info: ErrorInfo, prefix = '界面渲染崩溃'): string {
  const where = info.componentStack?.split('\n').slice(0, 3).join(' ').trim();
  return `${prefix}：${describeReason(error)}${where ? `\n位置：${where}` : ''}`;
}

interface Props { children: ReactNode }
interface State { crashed: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportUxError(renderCrashText(error, info));
  }

  render(): ReactNode {
    if (this.state.crashed) {
      return (
        <div className="crash-fallback">
          <p>界面出错了，错误仅在本地记录，不会自动执行代理。</p>
          <Button variant="primary" onClick={() => window.location.reload()}>重新加载</Button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface RegionProps {
  // Names the region in the fallback sentence, e.g. 这条消息 → 显示这条消息失败.
  label: string;
  children: ReactNode;
  // A changed key (new input for the region) retries automatically.
  resetKey?: unknown;
  // Places the fallback inside the region's own frame (for example a panel header).
  frame?: (fallback: ReactNode) => ReactNode;
  className?: string;
}
interface RegionState { error: string | null; resetKey: unknown }

export class RegionErrorBoundary extends Component<RegionProps, RegionState> {
  state: RegionState = { error: null, resetKey: this.props.resetKey };
  private recorded: string | null = null;

  static getDerivedStateFromError(error: unknown): Partial<RegionState> {
    return { error: describeReason(error, false) || '未知错误' };
  }

  static getDerivedStateFromProps(props: RegionProps, state: RegionState): Partial<RegionState> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const text = renderCrashText(error, info, `${this.props.label}渲染失败`);
    // A region that keeps failing on each new input is recorded once, not per update.
    if (text === this.recorded) return;
    this.recorded = text;
    recordUxDiagnostic(text);
  }

  private retry = (): void => { this.setState({ error: null }); };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const { label, frame, className = '' } = this.props;
    const fallback = <div className={`region-error ${className}`.trim()} data-region-error={label}>
      <OperationResult state="failed" name={label} details={error}
        action={{ label: '重试', onClick: this.retry }}>
        {`${copy.failed(`显示${label}`, '')}，其余界面不受影响。`}
      </OperationResult>
    </div>;
    return frame ? frame(fallback) : fallback;
  }
}
