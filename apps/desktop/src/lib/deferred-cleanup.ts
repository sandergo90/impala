export function createDeferredCleanupScheduler(
  schedule: (cleanup: () => void) => void = queueMicrotask,
) {
  let generation = 0;
  return {
    cancelPendingCleanup() {
      generation += 1;
    },
    scheduleCleanup(cleanup: () => void) {
      const cleanupGeneration = ++generation;
      schedule(() => {
        if (cleanupGeneration === generation) cleanup();
      });
    },
  };
}
