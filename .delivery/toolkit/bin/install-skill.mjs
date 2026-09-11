#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { installSkill } from '../lib/install.mjs';

try {
  const { values } = parseArgs({ options: { 'skills-dir': { type: 'string' } }, strict: true });
  console.log(JSON.stringify(installSkill(values['skills-dir'] ?? join(homedir(), '.copilot/skills')), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
