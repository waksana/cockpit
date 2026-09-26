import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { DeploymentConfig, ReleaseTarget } from '../deployment/contracts.ts';
import { DeploymentStore } from '../deployment/store.ts';
import { DeploymentRunner } from '../deployment/runner.ts';
import { GithubReleases } from '../deployment/releases.ts';
import { createDeploymentService } from '../deployment/service.ts';
import { assertControllerUnit, SystemdHost } from '../deployment/systemd.ts';
import { fixtureGithub } from './deployment-github.ts';

const config = DeploymentConfig.parse(JSON.parse(await readFile(process.argv[2]!, 'utf8')));
const releases = z.array(z.object({ target: ReleaseTarget, bytes: z.string(), assetId: z.number() }))
  .parse(JSON.parse(await readFile(process.argv[3]!, 'utf8')))
  .map(value => ({ ...value, bytes: Buffer.from(value.bytes, 'base64') }));
const store = new DeploymentStore(config.stateRoot);
await assertControllerUnit(config);
const runner = new DeploymentRunner(config, store, new SystemdHost(config), new GithubReleases(10000, fixtureGithub(() => releases)));
const service = await createDeploymentService(config, runner);
await service.app.listen({ host: '127.0.0.1', port: config.port });
process.on('SIGTERM', () => { void service.app.close(); });
