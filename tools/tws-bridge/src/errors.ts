/**
 * An error that maps to one HTTP answer: `{ "error": message, "code": code }` with `status`.
 *
 * `code` is a stable machine-readable name of the rule that said no (for example `halted`,
 * `duplicate`); `message` is the sentence shown to the owner.
 */
export class BridgeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message: string): BridgeError {
  return new BridgeError(400, "bad_request", message);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
