export async function settled<T extends readonly unknown[]>(work: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  // Teardown cannot race a sibling RPC that is still settling after another fails.
  const results = await Promise.allSettled(work);
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

export const readConcurrency = 4;

/**
 * Maps in input order with at most `limit` calls in flight. After a failure no
 * new calls start; started siblings settle before the first failure in input
 * order is thrown, so no read outlives the aggregate result.
 */
export async function boundedMap<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<PromiseSettledResult<R> | undefined>(items.length);
  let next = 0;
  let failed = false;
  const lane = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = { status: 'fulfilled', value: await work(items[index]!) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; failed = true; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  const failure = results.find(result => result?.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results.map(result => (result as PromiseFulfilledResult<R>).value);
}

export const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
