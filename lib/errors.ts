/**
 * Typed errors thrown by the Sure Petcare client.
 * The app uses these to decide between retrying, backing off or asking for new credentials.
 */

export class SureHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Credentials are missing or rejected by Sure Petcare. Retrying will not help. */
export class AuthError extends SureHubError {}

/** Sure Petcare answered with HTTP 429. */
export class RateLimitError extends SureHubError {
  public readonly retryAfterMs: number | null;

  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

/** The request never produced an HTTP response (offline, DNS failure, timeout). */
export class NetworkError extends SureHubError {}

/** Any other non-successful HTTP response. */
export class ApiError extends SureHubError {
  public readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
