import { checkExecution, abortable, currentExecution } from "./execution.js";

const pending = new Map<string, Promise<void>>();

export async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  let release: () => void = () => { };
  const completed = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => completed);
  pending.set(key, tail);
  try {
    await abortable(previous, currentExecution()?.signal);
    checkExecution();
    return await work();
  } finally {
    release();
    void tail.then(() => { if (pending.get(key) === tail) pending.delete(key); });
  }
}
