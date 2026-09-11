export interface ConsumerRestartReceipt {
  kind: 'restart';
  operationId: string;
  state: string;
  updatedAt: string;
  error?: string;
  observed?: {
    authority: 'consumer';
    installationId: string;
    sha: string;
    artifactSha256: string;
    version: string;
    requestId: string;
    instanceId: string;
  };
}
export function callLauncher(root: string, body: Record<string, unknown>): Promise<unknown>;
export function consumerRootFromEnvironment(env?: NodeJS.ProcessEnv): string;
export function restartConsumer(operationId: string, env?: NodeJS.ProcessEnv): Promise<ConsumerRestartReceipt>;
export function connectConsumerLifecycle(
  requestNativeDrain: (operationId: string) => void | Promise<void>,
  env?: NodeJS.ProcessEnv,
): Promise<() => void>;
export interface ConsumerExitReceipt {
  kind: 'prepare-exit';
  operationId: string;
  state: 'ready-to-exit';
  oldIdentity: { instanceId: string };
  joinedOperationId?: string;
}
export function prepareConsumerExit(env?: NodeJS.ProcessEnv): Promise<ConsumerExitReceipt>;
