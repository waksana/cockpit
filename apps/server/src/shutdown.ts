export async function drainForRestart(
  runtime: { stop(): Promise<void> },
): Promise<void> {
  await runtime.stop();
}
