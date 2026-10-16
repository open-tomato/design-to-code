/**
 * The serve verb's static server: a `node:http` server on `127.0.0.1` that
 * answers every `GET` or `HEAD` with the file under the project's
 * `source.dir` exactly as it is on disk.
 *
 * It is `node:http`, not `Bun.serve`, because `Bun.serve` normalizes a raw
 * `GET /../package.json` before the handler sees it, so the containment
 * check could never answer 403; `node:http` hands the raw target through as
 * `req.url`, which {@link resolveRequestPath} reads. Paths under `/__d2c/`
 * are reserved for the tool and never read from disk.
 *
 * {@link startServer} composes the modules beside it: the port comes from
 * `port.ts`, `.serve.json` is written and removed by `serve-record.ts`, the
 * nav bar comes from `nav.ts` (every HTML response gains the `nav-client.js`
 * `<script>` unless its query holds `d2c-nav=0`), and `/__d2c/pages` — the
 * nav model on `GET`, curation on `POST` through `config/save.ts` — is
 * answered by `pages-endpoint.ts`.
 *
 * @packageDocumentation
 */

import type { PagesConfig } from './nav.ts';
import type { PagesEndpointContext } from './pages-endpoint.ts';
import type { ServeRecord } from './serve-record.ts';
import type { PageChoice, PageChoices } from '../../config/save.ts';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { injectNav, navScriptTag } from './nav.ts';
import { handlePages, serialize } from './pages-endpoint.ts';
import { contentTypeFor, resolveRequestPath } from './paths.ts';
import { bindFirstFree, portCandidates } from './port.ts';
import { isNotFound, refuseMethod, sendBody, sendText } from './respond.ts';
import { removeServeRecord, writeServeRecord } from './serve-record.ts';

/** The only interface the server binds. */
export const SERVE_HOST = '127.0.0.1';

/** The first path segment reserved for the tool's own endpoints. */
export const RESERVED_SEGMENT = '__d2c';

/** The reserved path, relative to `source.dir`, of the nav bar's page list. */
export const PAGES_ENDPOINT = `${RESERVED_SEGMENT}/pages`;

/** The overlay's browser source, injected into every HTML response. */
export const NAV_CLIENT_PATH = join(import.meta.dirname, 'nav-client.js');

/** The content type prefix of a response the nav bar is injected into. */
const HTML_TYPE = 'text/html';

/** The methods the server answers for anything but `/__d2c/pages`. */
const ALLOWED_METHODS = 'GET, HEAD';

/** Options for {@link startServer}. */
export interface StartServerOptions {
  /** The directory to serve: the project's `source.dir`. */
  readonly sourceDir: string;
  /**
   * The port to bind; when set, it wins over `D2C_PORT` and never falls
   * back. `0` has the operating system assign a free port, which is the
   * port {@link RunningServer.port} and `.serve.json` then report. Only
   * this option takes `0`: `D2C_PORT=0` is refused.
   */
  readonly port?: number;
  /** The environment `D2C_PORT` is read from; `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Reads the project config's `pages` (its `keep` and `discard` lists),
   * called afresh for every `GET /__d2c/pages`. By default no page is
   * listed in either, so every page reads as kept.
   */
  readonly readPages?: () => PagesConfig;
  /**
   * The config writer `POST /__d2c/pages` calls: records `choice` for
   * `page` and returns both lists as written, such as `savePageChoice`
   * from `config/save.ts` bound to the project's slug. Calls are
   * serialized: one starts only after the previous one has settled. Unset,
   * curation is off and `POST /__d2c/pages` answers 405.
   */
  readonly savePage?: (page: string, choice: PageChoice) => PageChoices | Promise<PageChoices>;
}

/** What a request handler needs, fixed when the server starts. */
type ServeContext = PagesEndpointContext & {
  /** The nav `<script>` source, read once at start. */
  readonly navClient: string;
};

/** A running server, as {@link startServer} resolves it. */
export interface RunningServer {
  /** The base URL, such as `http://127.0.0.1:4600/`, naming the bound port. */
  readonly address: string;
  /** The port the server is bound to, never `0`, even when `0` was asked for. */
  readonly port: number;
  /**
   * Closes the server and removes `.serve.json` if it still names this
   * server. It resolves only once the listener has closed and every open
   * connection, idle keep-alive ones included, has been dropped and has
   * ended, so nothing answers at {@link RunningServer.address} afterwards.
   * Calling it again returns the same promise.
   */
  stop(): Promise<void>;
}

async function serveFile(
  context: ServeContext,
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
  relativePath: string,
): Promise<void> {
  let body: Buffer;

  try {
    body = await readFile(filePath);
  } catch (error) {
    if (isNotFound(error)) {
      sendText(response, 404, `not found: ${relativePath}`);

      return;
    }

    throw error;
  }

  const contentType = contentTypeFor(filePath);
  const served = contentType.startsWith(HTML_TYPE)
    ? injectNav(body, request.url ?? '', context.navClient)
    : body;

  sendBody(request, response, contentType, served);
}

function isReserved(relativePath: string): boolean {
  return relativePath === RESERVED_SEGMENT || relativePath.startsWith(`${RESERVED_SEGMENT}/`);
}

async function handle(context: ServeContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const resolution = resolveRequestPath(context.sourceDir, request.url ?? '');

  if (resolution.kind === 'refused') {
    sendText(response, resolution.status, resolution.reason);

    return;
  }

  if (resolution.relativePath === PAGES_ENDPOINT) {
    await handlePages(context, request, response);

    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    refuseMethod(response, request.method, ALLOWED_METHODS);

    return;
  }

  if (isReserved(resolution.relativePath)) {
    sendText(response, 404, `no tool endpoint at ${resolution.relativePath}`);

    return;
  }

  await serveFile(context, request, response, resolution.filePath, resolution.relativePath);
}

function requestListener(context: ServeContext) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    handle(context, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();

        return;
      }

      sendText(response, 500, `cannot serve ${request.url}: ${(error as Error).message}`);
    });
  };
}

/** Binds `server` to `port` on {@link SERVE_HOST}, rejecting with the listen error. */
function listenOn(server: Server, port: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onListening = (): void => {
      server.off('error', onError);
      resolvePromise();
    };
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      rejectPromise(error);
    };

    server.once('listening', onListening);
    server.once('error', onError);
    server.listen({ port, host: SERVE_HOST, exclusive: true });
  });
}

/** The port `server` is listening on, as its socket reports it. */
function boundPort(server: Server): number {
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('the server is listening but reports no TCP port');
  }

  return address.port;
}

/**
 * Collects every connection `server` accepts, dropping each once it has
 * closed, so whatever the set holds is a connection still open.
 */
function trackConnections(server: Server): ReadonlySet<Socket> {
  const open = new Set<Socket>();

  server.on('connection', (socket: Socket) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
  });

  return open;
}

/** Resolves once the listener has closed, rejecting with its close error. */
function closeListener(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);

        return;
      }

      resolvePromise();
    });
  });
}

/**
 * Stops `server` accepting connections and destroys every one in
 * `connections`, idle keep-alive ones included, resolving only once the
 * listener has closed and each of those sockets has emitted `close`.
 * `server.close` with `closeAllConnections` is not enough: under Node the
 * close callback can run before the sockets it dropped have closed.
 */
async function closeServer(server: Server, connections: ReadonlySet<Socket>): Promise<void> {
  const open = [...connections];
  const ended = open.map((socket) => new Promise<void>((resolvePromise) => {
    socket.once('close', () => resolvePromise());
  }));
  const listenerClosed = closeListener(server);

  for (const socket of open) {
    socket.destroy();
  }

  await Promise.all([listenerClosed, ...ended]);
}

function assertDirectory(sourceDir: string): void {
  if (!statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${sourceDir}: not a directory; nothing to serve`);
  }
}

/**
 * Serves `sourceDir` on {@link SERVE_HOST} and writes
 * `<sourceDir>/.serve.json` naming the address.
 *
 * The port is `port` when given, else `D2C_PORT` from `env`, else the first
 * free port from 4600 to 4699 (see `port.ts`). A `port` of `0` has the
 * operating system assign a free port. Either way, the address in
 * `.serve.json` and the returned `address` and `port` all name the port
 * the server actually bound, read back from its socket. Each file is answered byte
 * for byte with the content type its extension maps to, except that an
 * HTML file gains the nav `<script>` (read from {@link NAV_CLIENT_PATH}
 * once, here) before its last `</body>` unless the request's query holds
 * `d2c-nav=0`. A missing file answers 404, a target
 * {@link resolveRequestPath} refuses answers its 400 or 403, and any method
 * but `GET` or `HEAD` answers 405. `GET /__d2c/pages` answers the nav model
 * as JSON, built from `discovery.json` and `readPages()` read afresh each
 * time (404 while there is no `discovery.json`). `POST /__d2c/pages` with
 * `{ page, choice }` records the choice through `savePage`, one write at a
 * time, and answers 200 with both lists; it answers 403 for an `Origin`
 * header that is not the server's own origin, 400 for a malformed body or
 * a page `discovery.json` does not list, and 405 when no `savePage` was
 * given. Any other path under `/__d2c/` answers 404, and no path under it
 * is read from disk.
 *
 * @throws Error when `sourceDir` is not a directory or the nav client
 * cannot be read or wrapped, `ServePortError` when the port is invalid or
 * none binds, or the write error when `.serve.json` cannot be written (the
 * server is closed again first). Nothing is bound or written when the
 * port, the directory or the nav client is invalid.
 */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const { sourceDir, port: requestedPort, env = process.env, readPages = () => undefined, savePage } = options;
  const candidates = portCandidates(requestedPort, env);

  assertDirectory(sourceDir);

  const navClient = readFileSync(NAV_CLIENT_PATH, 'utf8');

  // Wrapping once here refuses a client that could not be injected before
  // anything is bound.
  navScriptTag(navClient);

  let origin = '';
  const save = savePage === undefined
    ? undefined
    : serialize(savePage);
  const server = createServer(requestListener({ sourceDir, navClient, readPages, save, origin: () => origin }));
  const connections = trackConnections(server);

  await bindFirstFree(candidates, (candidate) => listenOn(server, candidate));

  let record: ServeRecord;

  try {
    const port = boundPort(server);

    origin = `http://${SERVE_HOST}:${port}`;
    record = {
      address: `${origin}/`,
      port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    writeServeRecord(sourceDir, record);
  } catch (error) {
    await closeServer(server, connections);
    throw error;
  }

  let stopping: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    stopping ??= closeServer(server, connections).finally(() => {
      removeServeRecord(sourceDir, record);
    });

    return stopping;
  };

  return { address: record.address, port: record.port, stop };
}
