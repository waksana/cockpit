export function diagnosticOptions(kind: string, args?: string[], env?: NodeJS.ProcessEnv): { root: string };
export function readSyntheticLogs(root: string, env?: NodeJS.ProcessEnv): Array<{ name: string; events: unknown[] }>;
