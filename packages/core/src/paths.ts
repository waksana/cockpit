import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

export function cockpitHome(): string {
  const configured = process.env.COCKPIT_HOME;
  if (configured === undefined) return join(homedir(), '.cockpit');
  if (!configured.trim() || !isAbsolute(configured)) {
    throw new Error('COCKPIT_HOME must be a nonempty absolute host-root path');
  }
  return normalize(configured);
}

export function nativeHome(): string { return join(cockpitHome(), 'copilot'); }
