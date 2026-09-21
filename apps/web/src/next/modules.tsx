import type { SessionStatusProps } from '@cockpit/module-api';
import { useModuleElement } from '../components/ModuleComponents';

// These adapters contain no classic stylesheet or chat presentation. Sharing the
// context also keeps tests and module middleware on the one selected runtime.
export {
  // eslint-disable-next-line react-refresh/only-export-components
  ModuleRuntimeProvider, useModuleRuntime, useModuleElement,
  MessagePresentation, Attachment, MarkdownReplacement,
} from '../components/ModuleComponents';
// eslint-disable-next-line react-refresh/only-export-components
export { useRegisteredMenu } from '../components/useRegisteredMenu';

function StatusBase({ status, needsDecision, children }: SessionStatusProps) {
  const label = needsDecision ? '等待确认' : {
    unloaded: '未加载', idle: '空闲', running: '执行中', error: '出错',
  }[status];
  return <span className="next-session-status">{label}{children}</span>;
}

export function SessionStatus(props: SessionStatusProps) {
  return useModuleElement('sessionStatus', StatusBase, props);
}
