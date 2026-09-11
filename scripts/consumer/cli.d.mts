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
