export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export class DesignContextBlockedError extends CliError {
  constructor(message) {
    super(message, 2);
    this.name = "DesignContextBlockedError";
  }
}
