/**
 * Minimal static file server on Bun.serve, used by the visual suite in
 * place of http-server: http-server's `union` dependency monkey-patches node
 * HTTP internals and crashes under bun on Linux, and bun is the one runtime
 * guaranteed everywhere this pipeline runs.
 *
 *   bun scripts/serve-static.ts [dir=storybook-static] [port=6016]
 *
 * It listens on the loopback interface only. Each request path goes through
 * the serve verb's {@link resolveRequestPath}: a path that decodes to a NUL
 * byte or a malformed escape answers 400, one that resolves outside `dir`
 * (`/..%2fx`) answers 403, and neither touches the file system.
 *
 * @packageDocumentation
 */

import { readFile } from 'node:fs/promises';

import { contentTypeFor, resolveRequestPath } from '../pipeline/serve/paths.ts';

/** The only interface the server listens on. */
export const LOOPBACK_HOSTNAME = '127.0.0.1';

/** The directory served when the command line names none. */
export const DEFAULT_DIR = 'storybook-static';

/** The port served on when the command line names none. */
export const DEFAULT_PORT = 6016;

/** The options {@link startStaticServer} hands to `Bun.serve`. */
export interface StaticServeOptions {
  readonly hostname: string;
  readonly port: number;
  readonly fetch: (req: Request) => Promise<Response>;
}

/** Whether `error` is a system error with one of `codes`. */
function hasCode(error: unknown, codes: readonly string[]): boolean {
  return error instanceof Error && 'code' in error && codes.includes(String(error.code));
}

/**
 * The request handler: the file under `dir` that the request path names,
 * a 400 or 403 refusal from {@link resolveRequestPath}, or 404 when no such
 * file exists.
 *
 * @throws Error any read error other than a missing file or a directory.
 */
export function staticHandler(dir: string): (req: Request) => Promise<Response> {
  return async (req) => {
    const resolution = resolveRequestPath(dir, new URL(req.url).pathname);

    if (resolution.kind === 'refused') {
      return new Response(resolution.reason, { status: resolution.status });
    }

    try {
      const body = await readFile(resolution.filePath);

      return new Response(body, { headers: { 'content-type': contentTypeFor(resolution.filePath) } });
    } catch (error) {
      if (hasCode(error, ['ENOENT', 'EISDIR', 'ENOTDIR'])) {
        return new Response('not found', { status: 404 });
      }

      throw error;
    }
  };
}

/**
 * Serves `dir` on `port` of {@link LOOPBACK_HOSTNAME}.
 *
 * @param serve - Starts the server; `Bun.serve` by default.
 */
export function startStaticServer(
  dir: string,
  port: number,
  serve: (options: StaticServeOptions) => unknown = Bun.serve,
): void {
  serve({ hostname: LOOPBACK_HOSTNAME, port, fetch: staticHandler(dir) });
}

if (import.meta.main) {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  const port = Number(process.argv[3] ?? DEFAULT_PORT);

  startStaticServer(dir, port);
  console.log(`serving ${dir} on http://${LOOPBACK_HOSTNAME}:${port}`);
}
