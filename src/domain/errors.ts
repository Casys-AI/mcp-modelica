export interface ModelicaErrorDetails {
  /** Stable machine-readable error identity. */
  code: string;
  /** Canonical caller field, when one is known. */
  field?: string;
  /** Safe, bounded context; never source text, paths, or solver diagnostics. */
  context?: Readonly<Record<string, string | number | boolean>>;
  /** Concrete next action that does not broaden the execution authority. */
  recovery?: string;
}

export class ValidationError extends Error {
  readonly details?: ModelicaErrorDetails;

  constructor(message: string, details?: ModelicaErrorDetails) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

export class RunNotFoundError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Modelica run '${runId}' was not found.`);
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}
