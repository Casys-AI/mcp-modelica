export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Modelica run '${runId}' was not found.`);
    this.name = "RunNotFoundError";
  }
}
