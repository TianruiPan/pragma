export class CliError extends Error {
  constructor(message, exitCode = 1, code = "PRAGMA_CLI_ERROR", details = undefined) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

export class DesignContextBlockedError extends CliError {
  constructor(message) {
    super(message, 2);
    this.name = "DesignContextBlockedError";
  }
}
