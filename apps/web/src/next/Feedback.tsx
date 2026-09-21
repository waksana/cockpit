import { useSyncExternalStore } from 'react';
import { Alert, AlertDescription, AlertTitle, Button } from '@cockpit/ui';
import { dismissUxError, getUxErrors, subscribeUxErrors } from '../lib/errorReporter';

export function Errors() {
  const errors = useSyncExternalStore(subscribeUxErrors, getUxErrors, getUxErrors);
  if (!errors.length) return null;
  return <aside className="next-errors" aria-label="本地错误通知">
    {errors.map(error => <Alert key={error.id} variant="destructive">
      <AlertTitle>操作或界面出错</AlertTitle>
      <AlertDescription><p>{error.message}</p><Button variant="outline" onClick={event => {
        const button = event.currentTarget;
        if (document.activeElement === button) {
          const controls = Array.from(button.closest('aside')?.querySelectorAll<HTMLButtonElement>('button') ?? []);
          const index = controls.indexOf(button);
          const fallback = controls[index + 1] ?? controls[index - 1]
            ?? button.closest('[role="dialog"],[role="alertdialog"]')?.querySelector<HTMLElement>('[data-next-focus]')
            ?? document.querySelector<HTMLElement>('.next-main');
          fallback?.focus();
        }
        dismissUxError(error.id);
      }}>关闭错误通知</Button></AlertDescription>
    </Alert>)}
  </aside>;
}
