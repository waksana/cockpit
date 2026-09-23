import { createRoot } from 'react-dom/client';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { isolateLab } from './lab-isolation';
import '../styles/index.scss';
import '../components/UxErrorNotifications.scss';

// Install memory-only storage and reject application transports before any
// production component imports can inspect this authenticated origin.
isolateLab(window);
Object.defineProperty(window, 'WebSocket', {
  configurable: true,
  value: class { constructor() { throw new Error('Synthetic review: WebSocket is disabled.'); } },
});

const { useCockpit } = await import('../net/store');
useCockpit.setState({ connState: 'open', snapshotReady: true, init: () => () => {} });
const root = createRoot(document.getElementById('root')!);
if (import.meta.env.COCKPIT_CONTROL_DESIGN_REVIEW) {
  const { installFullWebFixture } = await import('./full-web-fixtures');
  const selected = new URLSearchParams(location.search).get('case') ?? 'mixed';
  const id = installFullWebFixture(useCockpit, selected);
  const { default: App } = await import('../App');
  const { ErrorBoundary } = await import('../components/ErrorBoundary');
  const { UxErrorNotifications } = await import('../components/UxErrorNotifications');
  document.title = 'Cockpit Web · 合成预览';
  root.render(<MemoryRouter initialEntries={[`/session/${id}`]}>
    <ErrorBoundary><App /></ErrorBoundary><UxErrorNotifications />
  </MemoryRouter>);
} else {
  await import('./chat-lab.scss');
  const { ActivityDesignLab } = await import('./activity-design-lab');
  root.render(<BrowserRouter><ActivityDesignLab /></BrowserRouter>);
}
