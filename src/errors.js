export class CliError extends Error {
  constructor(code, message, exitCode = 1, details = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}
export const usage = (message) => new CliError('VALIDATION_ERROR', message, 2);
export const invalidResponse = () =>
  new CliError('INVALID_RESPONSE', 'PostHog returned an invalid response.');
