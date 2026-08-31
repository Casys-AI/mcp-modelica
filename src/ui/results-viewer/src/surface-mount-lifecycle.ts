export interface DisposableSurfaceMount {
  dispose(): void | Promise<void>;
}

/** Own only the newest asynchronously mounted surface and clean every stale handle. */
export function createLatestSurfaceMountLifecycle<TMount extends DisposableSurfaceMount>() {
  let generation = 0;
  let mounted: TMount | undefined;

  const dispose = async (invalidate = true): Promise<void> => {
    if (invalidate) generation++;
    const current = mounted;
    mounted = undefined;
    await current?.dispose();
  };

  return {
    schedule(
      mount: () => Promise<TMount>,
      renderError: (error: unknown) => void,
    ): Promise<void> {
      const requestedGeneration = ++generation;
      return Promise.resolve().then(async () => {
        if (requestedGeneration !== generation) return;
        try {
          await dispose(false);
          if (requestedGeneration !== generation) return;
          const candidate = await mount();
          if (requestedGeneration !== generation) {
            await candidate.dispose();
            return;
          }
          mounted = candidate;
        } catch (error) {
          if (requestedGeneration === generation) renderError(error);
        }
      });
    },
    dispose,
    current(): TMount | undefined {
      return mounted;
    },
  };
}
