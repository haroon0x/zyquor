export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function asHttpError(error: unknown) {
  return error instanceof HttpError ? error : null;
}

export function isConflictError(error: Error) {
  return (
    error.message.startsWith("Cannot ") ||
    error.message.startsWith("Duplicate ") ||
    error.message.endsWith(" not found")
  );
}

export function isGenerationError(error: Error) {
  return (
    error.message.startsWith("Generation request failed:") ||
    error.message.startsWith("Command Code") ||
    error.message.includes(" returned no draft candidates")
  );
}

export function asError(error: unknown) {
  return error instanceof Error ? error : new Error("Unknown error");
}
