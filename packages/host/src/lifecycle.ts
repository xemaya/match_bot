/** Reverse disposal also handles partially completed startup. */
export function createCleanupStack() {
  const callbacks: (() => void | Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  return {
    add(dispose: () => void | Promise<void>) {
      if (closing) throw new Error('host already closing');
      callbacks.push(dispose);
    },
    close(): Promise<void> {
      closing ??= (async () => {
        const errors: unknown[] = [];
        for (const callback of callbacks.reverse()) {
          try {
            await callback();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'host cleanup failed');
      })();
      return closing;
    },
  };
}
