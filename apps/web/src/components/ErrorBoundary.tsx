// Catches React render errors, records local diagnostics, and shows a
// minimal fallback (instead of a blank screen). Reload recovers.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportUxError } from '../lib/errorReporter';

interface Props { children: ReactNode }
interface State { crashed: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const where = info.componentStack?.split('\n').slice(0, 3).join(' ').trim();
    reportUxError(`界面渲染崩溃：${error.message}${error.stack ? `\n${error.stack.split('\n').slice(0, 4).join('\n')}` : ''}${where ? `\n位置：${where}` : ''}`);
  }

  render(): ReactNode {
    if (this.state.crashed) {
      return (
        <div className="crash-fallback">
          <p>界面出错了，错误仅在本地记录，不会自动执行代理。</p>
          <button type="button" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      );
    }
    return this.props.children;
  }
}
