import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SessionStartCoordinator } from './session-start.ts';

const [userRoot, effectsDirectory, mode] = process.argv.slice(2);
let body = '';
for await (const chunk of process.stdin) body += chunk;
const coordinator = new SessionStartCoordinator({
  userRoot,
  prepare: input => ({ text: input.text }),
  engine: {
    async startSession(input) {
      if (mode === 'crash-before-create') process.exit(17);
      writeFileSync(join(effectsDirectory, `${input.sessionId}.native-create`), 'created', { flag: 'wx' });
      const deadline = Date.now() + 10_000;
      while (!existsSync(join(effectsDirectory, 'release'))) {
        if (Date.now() > deadline) throw new Error('Synthetic first-message send was not released');
        await sleep(10);
      }
      writeFileSync(join(effectsDirectory, `${input.sessionId}.native-send`), 'sent', { flag: 'wx' });
      return { ok: true };
    },
  },
});
process.stdout.write(`${JSON.stringify(await coordinator.start(JSON.parse(body)))}\n`);
