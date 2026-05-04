/**
 * Run `fn` over `items` with at most `limit` in flight at any time.
 * Returns results in the same order as the input.
 *
 * `limit` undefined or <= 0 → degenerates to `Promise.all` (unbounded).
 *
 * Used by the tool-dispatch chokepoint when a caller sets
 * `RunAgentInput.toolConcurrency`. Ported in spirit from intrebit's
 * `mapLimit` (operator/src/claude/specialists/base.ts).
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number | undefined,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit === undefined || limit <= 0 || items.length <= limit) {
    return Promise.all(items.map((item, i) => fn(item, i)));
  }

  const results: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  for (let w = 0; w < limit; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
