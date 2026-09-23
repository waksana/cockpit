// The one in-place operation result (docs/frontend-guidelines.md#operation-feedback):
// icon + one sentence + at most one action, with long causes folded into 详情.
// State is carried by the icon and the words, never by color alone.
import { useId, useState, type ReactNode } from 'react';
import { copy, type OperationState } from '../lib/copy';
import { operationErrorState } from '../lib/operationErrors';
import { Button } from './Button';
import { Disclosure } from './Disclosure';
import { Icon, type IconName } from './Icon';

// `info` is a confirmation or needs-action result that is neither done nor failed.
export type OperationResultState = OperationState | 'info';

const ICONS: Record<OperationResultState, IconName> = {
  busy: 'loading', done: 'success', failed: 'error', unknown: 'unknown', info: 'decision',
};

// `name` qualifies the details toggle when several results share a page.
export function OperationResult({ state, children, action, details, name = '', className = '' }: {
  state: OperationResultState; children: ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  details?: string | null; name?: string; className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const alert = state === 'failed' || state === 'unknown';
  return <div className={`operation-result ${className}`.trim()} data-state={state}>
    <div className="operation-result-line" role={alert ? 'alert' : 'status'}>
      <Icon name={ICONS[state]} className={state === 'busy' ? 'operation-result-icon spinner' : 'operation-result-icon'} size={16} />
      <span className="operation-result-text">{children}</span>
    </div>
    {(action || details) && <div className="operation-result-actions">
      {action && <Button className="operation-result-action" disabled={action.disabled} onClick={action.onClick}>{action.label}</Button>}
      {details && <Disclosure className="operation-result-disclosure" open={open} onToggle={() => setOpen(!open)}
        controls={id} label="详情" name={`${name}详情`} />}
    </div>}
    {details && <div id={id} className="operation-result-details" hidden={!open}>{details}</div>}
  </div>;
}

// A caught operation error worded as failed (known not applied) or unknown.
export function OperationErrorResult({ label, error, cause, ...rest }: {
  label: string; error: string; cause: unknown;
} & Omit<Parameters<typeof OperationResult>[0], 'state' | 'children'>) {
  const state = operationErrorState(cause);
  return <OperationResult state={state} {...rest}>
    {state === 'unknown' ? copy.unknown(error) : copy.failed(label, error)}
  </OperationResult>;
}
