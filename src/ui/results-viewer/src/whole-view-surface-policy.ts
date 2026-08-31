/** Presentation boundary between App-owned recorded views and host-selected direct components. */
export interface WholeViewSurfacePolicy<TSurface> {
  readonly componentOnly: boolean;
  readonly surface?: TSurface;
}

/**
 * Recorded sessions always render the complete App-owned surface and masthead.
 * Direct tool results retain host component selection, while a local list drill-down
 * may still request the App's complete detail surface inside that direct-mode shell.
 */
export function resolveWholeViewSurfacePolicy<TSurface>(options: {
  readonly recorded: boolean;
  readonly hostSelectedSurface: boolean;
  readonly defaultSurface: TSurface | undefined;
  readonly preferDefaultSurface?: boolean;
}): WholeViewSurfacePolicy<TSurface> {
  if (options.recorded) {
    if (options.defaultSurface === undefined) {
      throw new TypeError("A recorded whole view requires an App-owned default surface.");
    }
    return { componentOnly: false, surface: options.defaultSurface };
  }

  return {
    componentOnly: options.hostSelectedSurface,
    ...(options.preferDefaultSurface && options.defaultSurface !== undefined
      ? { surface: options.defaultSurface }
      : {}),
  };
}
