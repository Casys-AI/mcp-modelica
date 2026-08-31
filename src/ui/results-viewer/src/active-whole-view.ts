/** Persisted whole-view route used when host context changes require a component remount. */
export type ActiveWholeView<TList, TDetail> =
  | { readonly name: "status" }
  | { readonly name: "pending-detail" }
  | { readonly name: "list"; readonly envelope: TList }
  | { readonly name: "detail"; readonly data: TDetail };

export function remountActiveWholeView<TList, TDetail>(
  active: ActiveWholeView<TList, TDetail> | undefined,
  routes: {
    readonly list: (envelope: TList) => Promise<void>;
    readonly detail: (data: TDetail) => Promise<void>;
  },
): Promise<void> | undefined {
  if (active?.name === "list") return routes.list(active.envelope);
  if (active?.name === "detail") return routes.detail(active.data);
  return undefined;
}

/** Serialize whole-view transitions and invalidate remounts queued for an older display. */
export function createWholeViewTransitionCoordinator() {
  let generation = 0;
  let queue = Promise.resolve();

  const enqueue = (expectedGeneration: number, task: () => void | Promise<void>) => {
    const run = async (): Promise<void> => {
      if (expectedGeneration !== generation) return;
      await task();
    };
    queue = queue.then(run, run);
    return queue;
  };

  return {
    replace(task: () => void | Promise<void>): Promise<void> {
      return enqueue(++generation, task);
    },
    remount(task: () => void | Promise<void>): Promise<void> {
      return enqueue(generation, task);
    },
    drain(): Promise<void> {
      return queue;
    },
  };
}
