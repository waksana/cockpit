import { homedir } from 'node:os';
import { join } from 'node:path';

export function cockpitHome(): string {
  return process.env.COCKPIT_HOME ?? join(homedir(), '.copilot');
}
