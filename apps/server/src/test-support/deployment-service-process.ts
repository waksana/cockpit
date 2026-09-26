import { readFile } from 'node:fs/promises';
import { DeploymentConfig } from '../deployment/contracts.ts';
import { DeploymentStore } from '../deployment/store.ts';
import { DeploymentRunner } from '../deployment/runner.ts';
import { createDeploymentService } from '../deployment/service.ts';

const config = DeploymentConfig.parse(JSON.parse(await readFile(process.argv[2]!, 'utf8')));
const store = new DeploymentStore(config.stateRoot);
const runner = new DeploymentRunner(config, store, {
  inspect: async () => ({ pid: 0, active: 'inactive', sub: 'dead' }),
  stop: async () => { throw new Error('This interruption fixture never operates a host'); },
  start: async () => { throw new Error('This interruption fixture never operates a host'); },
  complete: async () => {},
});
runner.execute = async receipt => {
  await store.save(receipt, 'prepared');
  process.send?.({ claimed: receipt.id });
  await new Promise(() => {});
};
const service = await createDeploymentService(config, runner);
const origin = await service.app.listen({ host: '127.0.0.1', port: 0 });
process.send?.({ origin });
