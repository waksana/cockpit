import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { isolateNextLab } from './next-lab-isolation';
import '../styles/index.scss';
import './chat-lab.scss';

// Install memory-only storage and reject application transports before any
// production component imports can inspect this authenticated origin.
isolateNextLab(window);
Object.defineProperty(window, 'WebSocket', {
  configurable: true,
  value: class { constructor() { throw new Error('Synthetic review: WebSocket is disabled.'); } },
});

const { useCockpit } = await import('../net/store');
useCockpit.setState({ connState: 'open', snapshotReady: true, init: () => () => {} });
const root = createRoot(document.getElementById('root')!);
if (import.meta.env.COCKPIT_CONTROL_DESIGN_REVIEW) {
  const { ControlDesignLab } = await import('./control-design-lab');
  root.render(<BrowserRouter><ControlDesignLab /></BrowserRouter>);
} else {
  const { ActivityDesignLab } = await import('./activity-design-lab');
  root.render(<BrowserRouter><ActivityDesignLab /></BrowserRouter>);
}
