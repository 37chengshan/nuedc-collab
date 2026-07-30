export class DigitalKeyAgentError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "DigitalKeyAgentError";
    this.code = code;
    this.status = options.status ?? 400;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? null;
  }
}

export function normalizeAgentError(error) {
  if (error instanceof DigitalKeyAgentError) {
    return error;
  }
  if (error && typeof error === "object" && typeof error.code === "string") {
    return new DigitalKeyAgentError(
      error.code,
      error instanceof Error ? error.message : String(error.message ?? error),
      {
        status:
          Number.isInteger(error.status) && error.status >= 400
            ? error.status
            : 500,
        retryable: error.retryable === true,
        details: error.details ?? null,
      },
    );
  }
  return new DigitalKeyAgentError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : String(error),
    {
      status: 500,
      retryable: false,
    },
  );
}
