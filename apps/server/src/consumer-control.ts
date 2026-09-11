import { z } from 'zod';
import { ConsumerIdentity, ConsumerOperation, ConsumerStatus } from '@cockpit/protocol';
import { callLauncher, connectConsumerLifecycle, consumerRootFromEnvironment, prepareConsumerExit,
  restartConsumer } from '../../../scripts/consumer/cli.mjs';
import { operationPath, readJson } from '../../../scripts/consumer/state.mjs';

const LauncherStatus = z.object({
  authority: z.literal('consumer'), installationId: z.string().uuid(), active: z.string().nullable(),
  health: z.object({
    state: z.enum(['healthy', 'unavailable', 'stopped']),
    identity: ConsumerIdentity.optional(), error: z.string().optional(),
  }),
  mainLifecycle: z.object({ ready: z.boolean(), error: z.string().optional() }).nullable(),
  moduleRunner: z.object({ state: z.string().min(1) }),
});

export interface ConsumerControl {
  status(operationId?: string): Promise<ConsumerStatus>;
  restart(operationId: string): Promise<ConsumerOperation>;
  prepareExit(): Promise<void>;
  connect(armNativeDrain: () => void): Promise<void>;
}

export function createConsumerControl(env = process.env): ConsumerControl | undefined {
  if (!env.COCKPIT_CONSUMER_INSTALLATION) return undefined;
  const root = consumerRootFromEnvironment(env);
  return {
    async status(operationId) {
      const value = LauncherStatus.parse(await callLauncher(root, { action: 'status' }));
      if (value.installationId !== env.COCKPIT_CONSUMER_INSTALLATION) throw new Error('Consumer installation changed during status read');
      const id = operationId ?? value.active;
      const operation = id ? ConsumerOperation.parse(readJson(operationPath(root, id))) : null;
      if (operation && operation.operationId !== id) throw new Error('Consumer operation identity mismatch');
      if (value.health.state === 'healthy' && (!value.health.identity || value.health.identity.installationId !== value.installationId)) {
        throw new Error('Current consumer runtime identity is unconfirmed');
      }
      return ConsumerStatus.parse({
        available: true, installationId: value.installationId, health: value.health.state,
        runtime: value.health.state === 'healthy' ? value.health.identity : null,
        mainLifecycleReady: value.mainLifecycle?.ready === true, moduleRunnerState: value.moduleRunner.state,
        activeOperationId: value.active, operation, ...(value.health.error ? { error: value.health.error } : {}),
      });
    },
    async restart(operationId) { return ConsumerOperation.parse(await restartConsumer(operationId, env)); },
    async prepareExit() { await prepareConsumerExit(env); },
    async connect(armNativeDrain) { await connectConsumerLifecycle(armNativeDrain, env); },
  };
}
