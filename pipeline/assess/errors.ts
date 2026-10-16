/**
 * The error assess throws when it refuses what it was given, as opposed to
 * failing to read it.
 *
 * @packageDocumentation
 */

/**
 * A refusal by assess: an entry in the export that is neither a regular
 * file nor a directory, a sampled page that resolves outside the source dir
 * or is not a regular file, or a report path outside the source dir. Its
 * message is ready to print as it stands; `path` names the offending path.
 * An I/O failure such as `ENOENT` or `EACCES` is never wrapped in one and
 * propagates as the system error it is.
 */
export class AssessRefusedError extends Error {
  override readonly name = 'AssessRefusedError';

  /** The offending path, as the message names it. */
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}
