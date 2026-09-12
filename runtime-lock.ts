const queues = new Map<string, Promise<void>>();

export function withRuntimeLock<T>(
  key: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const previous = queues.get(key) ?? Promise.resolve();
  let started = false;
  const running = previous.then(() => {
    signal.throwIfAborted();
    started = true;
    return operation();
  });
  const tail = running.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      if (!started) reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void running
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
