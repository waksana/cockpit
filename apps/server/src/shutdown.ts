export async function drainForRestart(
  runtime: { stop(): Promise<void> },
  notifications: ReadonlySet<Promise<unknown>>,
): Promise<void> {
  await runtime.stop();
  await Promise.allSettled([...notifications]);
}
