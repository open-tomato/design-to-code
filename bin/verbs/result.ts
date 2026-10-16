/**
 * What a CLI verb hands back to the dispatcher in `bin/d2c.ts`, and the
 * helper the verbs share for telling a rejected argument from any other
 * error.
 *
 * @packageDocumentation
 */

/** What one CLI invocation writes and the exit code it ends with. */
export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Stops what the verb left running. Only `serve` without `--check` sets
   * it: its server outlives the call, and whoever called the verb stops
   * it (the CLI entry point does so on SIGINT or SIGTERM).
   */
  readonly stop?: () => Promise<void>;
}

/**
 * A failure the verb reports itself: `d2c <verb>: <message>` on stderr,
 * nothing on stdout, exit 1.
 *
 * @param verb - The verb that failed, as typed on the command line.
 * @param message - What went wrong, without a trailing newline.
 */
export function verbFailure(verb: string, message: string): CliResult {
  return { exitCode: 1, stdout: '', stderr: `d2c ${verb}: ${message}\n` };
}

/**
 * Whether `error` is one `node:util` `parseArgs` throws for arguments it
 * rejects, as opposed to a bug or an I/O failure.
 */
export function isParseArgsError(error: unknown): error is Error {
  return error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && error.code.startsWith('ERR_PARSE_ARGS_');
}
