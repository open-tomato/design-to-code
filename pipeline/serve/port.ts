/**
 * Port selection for the serve verb: which ports the server tries, in what
 * order, and the loop that takes the first one that binds.
 *
 * A port the caller names, or one set in `D2C_PORT`, is the only candidate,
 * and a port already in use is an error, never a reason to fall back.
 * `D2C_PORT` must be an integer from 1 to 65535. A port the caller names
 * may also be {@link OS_ASSIGNED_PORT} (0), which asks the operating system
 * for any free port; it is a programmatic option only, so `D2C_PORT=0` is
 * still refused. With neither, the server tries
 * {@link FIRST_PORT} upward to {@link LAST_PORT} and takes the first port
 * that binds. Nothing here opens a socket: {@link bindFirstFree} is handed
 * the function that tries one port.
 *
 * @packageDocumentation
 */

/** The environment variable that names the port to serve on. */
export const PORT_ENV = 'D2C_PORT';

/** The first port tried when no port is named. */
export const FIRST_PORT = 4600;

/** The last port tried when no port is named. */
export const LAST_PORT = 4699;

/**
 * The port a caller names to have the operating system assign a free one.
 * The server then reports the port it actually bound, never this value.
 */
export const OS_ASSIGNED_PORT = 0;

/** The highest valid TCP port. */
const MAX_PORT = 65535;

/** A port outside the range its source allows (see {@link portCandidates}), or none that binds. */
export class ServePortError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ServePortError';
  }
}

/**
 * Reads `D2C_PORT` from `env`.
 *
 * @returns The port, or `undefined` when the variable is not set.
 * @throws {@link ServePortError} when it is set to anything but a decimal
 * integer from 1 to 65535 with no sign, spaces or leading zeros (an empty
 * value is set, and invalid).
 */
export function portFromEnv(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const value = env[PORT_ENV];

  if (value === undefined) {
    return undefined;
  }

  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > MAX_PORT) {
    throw new ServePortError(`${PORT_ENV} must be an integer from 1 to ${MAX_PORT}, got "${value}"`);
  }

  return Number(value);
}

/**
 * The ports to try, in order: `port` alone when given, else `D2C_PORT`
 * alone when set, else {@link FIRST_PORT} to {@link LAST_PORT}. A `port` of
 * {@link OS_ASSIGNED_PORT} (0) is returned as `[0]`, so the listen asks the
 * operating system for a free port; the caller reads the bound port back
 * from its socket.
 *
 * @throws {@link ServePortError} when `port` is not an integer from 0 to
 * 65535, or when `D2C_PORT` is invalid ({@link portFromEnv}), which
 * includes `D2C_PORT=0`.
 */
export function portCandidates(
  port: number | undefined,
  env: Readonly<Record<string, string | undefined>>,
): readonly number[] {
  if (port !== undefined) {
    if (!Number.isInteger(port) || port < OS_ASSIGNED_PORT || port > MAX_PORT) {
      throw new ServePortError(`port must be an integer from ${OS_ASSIGNED_PORT} to ${MAX_PORT}, got ${port}`);
    }

    return [port];
  }

  const envPort = portFromEnv(env);

  if (envPort !== undefined) {
    return [envPort];
  }

  return Array.from({ length: LAST_PORT - FIRST_PORT + 1 }, (_, offset) => FIRST_PORT + offset);
}

/** Whether `error` is the one a listen on a taken port fails with. */
export function isPortInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

/**
 * Tries each candidate in order with `tryPort` and resolves to the first
 * candidate it binds (which is {@link OS_ASSIGNED_PORT} itself for that
 * candidate: the bound port is the caller's to read from its socket). A port in use moves on to the next candidate; any other
 * failure rejects at once.
 *
 * @throws {@link ServePortError} when the only candidate is in use (a named
 * port never falls back), or when every candidate in a range is in use.
 */
export async function bindFirstFree(
  candidates: readonly number[],
  tryPort: (port: number) => Promise<void>,
): Promise<number> {
  for (const port of candidates) {
    try {
      await tryPort(port);

      return port;
    } catch (error) {
      if (!isPortInUse(error)) {
        throw error;
      }
    }
  }

  throw new ServePortError(candidates.length === 1
    ? `port ${candidates[0]} is already in use`
    : `no free port from ${candidates[0]} to ${candidates.at(-1)}`);
}
