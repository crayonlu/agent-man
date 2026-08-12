export class AppError extends Error {
  public readonly code: string;
  public readonly exitCode: number;

  public constructor(message: string, code = "AGENT_MAN_ERROR", exitCode = 1) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "UNEXPECTED_ERROR";
}
