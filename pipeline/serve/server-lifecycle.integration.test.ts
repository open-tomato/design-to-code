import type { RunningServer } from './server.ts';
import type { Server, Socket } from 'node:net';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { discover, writeDiscovery } from '../assess/discover.ts';

import { navScriptTag } from './nav.ts';
import { FIRST_PORT, LAST_PORT, ServePortError } from './port.ts';
import { NAV_CLIENT_PATH, SERVE_HOST, startServer } from './server.ts';

/**
 * How long {@link hold} keeps retrying a port another suite holds briefly.
 * Kept well under {@link FALLBACK_TEST_TIMEOUT_MS} so a port that stays taken
 * fails the test with {@link hold}'s message, not with the runner's timeout.
 */
const HOLD_DEADLINE_MS = 5_000;

/** The fallback test's own timeout: the hold deadline plus room to start a server. */
const FALLBACK_TEST_TIMEOUT_MS = 15_000;

const HOLD_RETRY_MS = 100;

const SCRIPT = 'window.shared = 1;\n';

let workDir: string;
let sourceDir: string;
let running: RunningServer[];
let held: Server[];

/** Binds a plain TCP listener to `port` on the serve host, once. */
function listen(port: number): Promise<Server> {
  const blocker = createServer();

  return new Promise((resolvePromise, rejectPromise) => {
    blocker.once('error', rejectPromise);
    blocker.listen({ port, host: SERVE_HOST, exclusive: true }, () => resolvePromise(blocker));
  });
}

/**
 * Takes `port` for the rest of the test, retrying while another suite's
 * server holds it, so the test itself is what makes the port taken. Throws
 * an error naming the port and the deadline once `deadlineMs` has passed
 * with the port still taken.
 */
async function hold(port: number, deadlineMs = HOLD_DEADLINE_MS): Promise<Server> {
  const deadline = Date.now() + deadlineMs;

  for (;;) {
    try {
      const blocker = await listen(port);

      held.push(blocker);

      return blocker;
    } catch (error) {
      if (Date.now() + HOLD_RETRY_MS > deadline) {
        throw new Error(`port ${port} stayed taken for ${deadlineMs} ms, so this test could not hold it`, { cause: error });
      }

      await new Promise((resolvePromise) => setTimeout(resolvePromise, HOLD_RETRY_MS));
    }
  }
}

/** The port a bound TCP listener holds. */
function portOf(listener: Server): number {
  const address = listener.address();

  if (address === null || typeof address === 'string') {
    throw new Error('listener has no port');
  }

  return address.port;
}

/** A port the OS reports free right now. */
async function freePort(): Promise<number> {
  const probe = await listen(0);
  const port = portOf(probe);

  await new Promise((resolvePromise) => probe.close(resolvePromise));

  return port;
}

/** Opens a TCP connection and reports `connected` or the error code. */
function connectCode(host: string, port: number): Promise<string> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host, port });

    socket.once('connect', () => {
      socket.destroy();
      resolvePromise('connected');
    });
    socket.once('error', (error) => resolvePromise('code' in error && typeof error.code === 'string'
      ? error.code
      : error.message));
  });
}

/**
 * Opens a raw HTTP/1.1 connection to `port`, reads the whole response to one
 * `GET` of the shared script and leaves the socket open and idle, the way a
 * keep-alive client holds it between requests.
 */
function openKeepAlive(port: number): Promise<Socket> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ host: SERVE_HOST, port });
    let received = '';

    socket.setEncoding('utf8');
    socket.once('error', rejectPromise);
    socket.on('data', (chunk: string) => {
      received += chunk;

      if (received.endsWith(SCRIPT)) {
        socket.off('error', rejectPromise);
        resolvePromise(socket);
      }
    });
    socket.write(`GET /app%20parts/shared.js HTTP/1.1\r\nHost: ${SERVE_HOST}:${port}\r\nConnection: keep-alive\r\n\r\n`);
  });
}

async function start(options: Omit<Parameters<typeof startServer>[0], 'sourceDir'> = {}): Promise<RunningServer> {
  const server = await startServer({ sourceDir, env: {}, ...options });

  running.push(server);

  return server;
}

function readRecord(): unknown {
  return JSON.parse(readFileSync(join(sourceDir, '.serve.json'), 'utf8'));
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-serve-server-test-'));
  sourceDir = join(workDir, 'source');
  mkdirSync(join(sourceDir, 'app parts'), { recursive: true });
  writeFileSync(join(sourceDir, 'app parts', 'shared.js'), SCRIPT);
  running = [];
  held = [];
});

afterEach(async () => {
  await Promise.all(running.map((server) => server.stop()));
  await Promise.all(held.map((blocker) => new Promise((resolvePromise) => blocker.close(resolvePromise))));
  rmSync(workDir, { recursive: true, force: true });
});

describe('startServer port selection', () => {
  test('falls back past 4600 when 4600 is taken', async () => {
    await hold(FIRST_PORT);

    const server = await start();

    expect(server.port).toBeGreaterThan(FIRST_PORT);
    expect(server.port).toBeLessThanOrEqual(LAST_PORT);
    expect(server.address).toBe(`http://127.0.0.1:${server.port}/`);
    expect((await fetch(`${server.address}app%20parts/shared.js`)).status).toBe(200);
  }, FALLBACK_TEST_TIMEOUT_MS);

  test('hold fails with a message naming the port when it stays taken past the deadline', async () => {
    const port = portOf(await hold(await freePort()));

    await expect(hold(port, HOLD_RETRY_MS * 3)).rejects.toThrow(`port ${port} stayed taken for ${HOLD_RETRY_MS * 3} ms`);
  });

  test('serves on a port the OS assigns for port 0, and two such servers get different ports', async () => {
    const otherDir = join(workDir, 'other');

    mkdirSync(otherDir);
    writeFileSync(join(otherDir, 'other.js'), 'window.other = 1;\n');

    const [first, second] = await Promise.all([
      start({ port: 0 }),
      startServer({ sourceDir: otherDir, env: {}, port: 0 }).then((server) => {
        running.push(server);

        return server;
      }),
    ]);

    expect(first.port).toBeGreaterThan(0);
    expect(second.port).toBeGreaterThan(0);
    expect(first.port).not.toBe(second.port);
    expect(first.address).toBe(`http://127.0.0.1:${first.port}/`);
    expect(second.address).toBe(`http://127.0.0.1:${second.port}/`);
    expect(await (await fetch(`${first.address}app%20parts/shared.js`)).text()).toBe(SCRIPT);
    expect(await (await fetch(`${second.address}other.js`)).text()).toBe('window.other = 1;\n');
  });

  test('records the bound port, not 0, in .serve.json for port 0', async () => {
    const server = await start({ port: 0 });

    expect(server.port).toBeGreaterThan(0);
    expect(readRecord()).toMatchObject({ address: server.address, port: server.port });
  });

  test('takes port 0 over D2C_PORT', async () => {
    const server = await start({ port: 0, env: { D2C_PORT: 'not-a-port' } });

    expect(server.port).toBeGreaterThan(0);
  });

  test('serves on D2C_PORT when it is set and free', async () => {
    const port = await freePort();
    const server = await start({ env: { D2C_PORT: String(port) } });

    expect(server.port).toBe(port);
  });

  test('refuses a taken D2C_PORT instead of falling back, writing no record', async () => {
    const port = await freePort();

    await hold(port);

    await expect(start({ env: { D2C_PORT: String(port) } })).rejects.toThrow(new ServePortError(`port ${port} is already in use`));
    expect(existsSync(join(sourceDir, '.serve.json'))).toBe(false);
  });

  test.each(['0', '65536', 'abc', '5123.5', ''])('refuses D2C_PORT="%s" before binding or writing', async (value) => {
    await expect(start({ env: { D2C_PORT: value } })).rejects.toThrow(ServePortError);
    expect(existsSync(join(sourceDir, '.serve.json'))).toBe(false);
  });

  test('reads D2C_PORT from process.env when no env is passed', async () => {
    const previous = process.env.D2C_PORT;

    process.env.D2C_PORT = 'not-a-port';

    try {
      await expect(startServer({ sourceDir })).rejects.toThrow('D2C_PORT must be an integer from 1 to 65535, got "not-a-port"');
    } finally {
      if (previous === undefined) {
        delete process.env.D2C_PORT;
      } else {
        process.env.D2C_PORT = previous;
      }
    }
  });

  test('refuses a source dir that does not exist', async () => {
    await expect(startServer({ sourceDir: join(workDir, 'missing'), env: {}, port: 0 })).rejects.toThrow('not a directory; nothing to serve');
  });
});

describe('startServer .serve.json', () => {
  test('is written with address, port, pid and startedAt, then removed on stop()', async () => {
    const before = Date.now();
    const server = await start({ port: 0 });
    const record = readRecord() as Record<string, unknown>;

    expect(Object.keys(record)).toEqual(['address', 'port', 'pid', 'startedAt']);
    expect(record).toMatchObject({ address: server.address, port: server.port, pid: process.pid });
    expect(new Date(record.startedAt as string).toISOString()).toBe(record.startedAt);
    expect(Date.parse(record.startedAt as string)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(record.startedAt as string)).toBeLessThanOrEqual(Date.now());

    await server.stop();

    expect(existsSync(join(sourceDir, '.serve.json'))).toBe(false);
    await expect(fetch(server.address)).rejects.toThrow();
  });

  test('stop() leaves a record another server wrote over it', async () => {
    const first = await start({ port: 0 });
    const second = await start({ port: 0 });

    expect(readRecord()).toMatchObject({ port: second.port });

    await first.stop();

    expect(readRecord()).toMatchObject({ port: second.port });

    await second.stop();

    expect(existsSync(join(sourceDir, '.serve.json'))).toBe(false);
  });
});

describe('startServer stop()', () => {
  test('leaves the address refusing a fetch once it resolves, with no request made before', async () => {
    const server = await start({ port: 0 });

    await server.stop();

    await expect(fetch(server.address)).rejects.toThrow();
    expect(await connectCode(SERVE_HOST, server.port)).toBe('ECONNREFUSED');
  });

  test('ends an idle keep-alive connection opened before it, and the address then refuses a fetch', async () => {
    const server = await start({ port: 0 });
    const url = `${server.address}app%20parts/shared.js`;
    // fetch keeps this connection in its pool, so the fetch after stop()
    // would reuse it if the server left it open.
    expect(await (await fetch(url)).text()).toBe(SCRIPT);
    const idle = await openKeepAlive(server.port);
    const ended = new Promise<void>((resolvePromise) => idle.once('close', () => resolvePromise()));

    // Control: the connection outlived its response, so stop() has an idle
    // keep-alive connection to end.
    expect(idle.destroyed).toBe(false);

    await server.stop();

    await expect(fetch(url)).rejects.toThrow();
    await ended;
    expect(idle.destroyed).toBe(true);
  });

  test('returns the same settled promise when called again', async () => {
    const server = await start({ port: 0 });
    const first = server.stop();

    await first;

    const second = server.stop();

    expect(second).toBe(first);
    await expect(second).resolves.toBeUndefined();
  });
});

describe('startServer binding', () => {
  test('binds 127.0.0.1 only, so the IPv6 loopback is refused', async () => {
    const server = await start({ port: 0 });
    // Control: a listener on every interface is reachable through ::1, so
    // the refusal below comes from the bind, not from a missing IPv6 loopback.
    const everywhere = createServer();

    await new Promise<void>((resolvePromise) => everywhere.listen({ port: 0 }, resolvePromise));
    held.push(everywhere);

    expect(await connectCode('::1', portOf(everywhere))).toBe('connected');
    expect(await connectCode('::1', server.port)).toBe('ECONNREFUSED');
    expect(await connectCode(SERVE_HOST, server.port)).toBe('connected');
  });
});

describe('startServer responses', () => {
  test('answers a file byte for byte with its content type', async () => {
    const server = await start({ port: 0 });
    const response = await fetch(`${server.address}app%20parts/shared.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(join(sourceDir, 'app parts', 'shared.js')));
  });

  test('answers HEAD with the headers and no body', async () => {
    const server = await start({ port: 0 });
    const response = await fetch(`${server.address}app%20parts/shared.js`, { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(SCRIPT)));
    expect(await response.text()).toBe('');
  });

  test('answers 404 for a missing file', async () => {
    const server = await start({ port: 0 });

    expect((await fetch(`${server.address}missing.html`)).status).toBe(404);
  });

  test('answers 404 under /__d2c/ even when the export holds such a file', async () => {
    mkdirSync(join(sourceDir, '__d2c'));
    writeFileSync(join(sourceDir, '__d2c', 'other'), 'from disk');
    const server = await start({ port: 0 });
    const response = await fetch(`${server.address}__d2c/other`);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('from disk');
  });

  test('answers 400 for malformed percent-encoding', async () => {
    const server = await start({ port: 0 });

    expect((await fetch(`${server.address}bad%zz.js`)).status).toBe(400);
  });

  test('answers 405 for a method other than GET or HEAD', async () => {
    const server = await start({ port: 0 });
    const response = await fetch(`${server.address}app%20parts/shared.js`, { method: 'POST', body: 'x' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});

const V1 = 'Rafa Portal.dc.html';
const V2 = 'Rafa Portal v2.dc.html';
const ABOUT = 'about.html';

/** A page whose last `</BODY>` is upper case and follows an earlier one in a comment. */
const PAGE = '<!doctype html>\n<html><head><title>Portal</title></head>\n<body><!-- </body> -->\n<h1>Portal</h1>\n</BODY>\n</html>\n';

/** Fetches `url` on a socket that is never pooled across server instances. */
function fetchOnce(url: string, init: { readonly method?: string } = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { connection: 'close' } });
}

/** Writes three pages and a `discovery.json` grouping two of them as versions. */
function writePagesAndDiscovery(): void {
  writeFileSync(join(sourceDir, V1), PAGE);
  writeFileSync(join(sourceDir, V2), PAGE);
  writeFileSync(join(sourceDir, ABOUT), '<p>about</p>\n');

  const report = discover(sourceDir, { now: new Date('2026-09-30T12:00:00.000Z') });

  writeDiscovery(sourceDir, { ...report, agentNotes: { ...report.agentNotes, versionGroups: [[V2, V1]] } });
}

describe('startServer nav bar injection', () => {
  const tag = (): string => navScriptTag(readFileSync(NAV_CLIENT_PATH, 'utf8'));

  test('inserts the nav client script before the last </body>, leaving every other byte as on disk', async () => {
    writePagesAndDiscovery();
    const server = await start({ port: 0 });
    const response = await fetchOnce(`${server.address}Rafa%20Portal.dc.html`);
    const body = Buffer.from(await response.arrayBuffer());
    const at = PAGE.lastIndexOf('</BODY>');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-length')).toBe(String(body.byteLength));
    expect(body.toString('utf8')).toBe(`${PAGE.slice(0, at)}${tag()}${PAGE.slice(at)}`);
  });

  test('appends the script to a page with no </body>', async () => {
    writePagesAndDiscovery();
    const server = await start({ port: 0 });
    const response = await fetchOnce(`${server.address}${ABOUT}`);

    expect(await response.text()).toBe(`<p>about</p>\n${tag()}`);
  });

  test('serves the page byte for byte when the query holds d2c-nav=0', async () => {
    writePagesAndDiscovery();
    const server = await start({ port: 0 });
    const response = await fetchOnce(`${server.address}Rafa%20Portal.dc.html?x=1&d2c-nav=0`);

    expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(join(sourceDir, V1)));
  });

  test('answers HEAD for a page with the injected length and no body', async () => {
    writePagesAndDiscovery();
    const server = await start({ port: 0 });
    const response = await fetchOnce(`${server.address}Rafa%20Portal.dc.html`, { method: 'HEAD' });

    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(PAGE) + Buffer.byteLength(tag())));
    expect(await response.text()).toBe('');
  });

  test('leaves a non-HTML file untouched even when it holds </body>', async () => {
    writeFileSync(join(sourceDir, 'notes.txt'), 'a </body> b\n');
    const server = await start({ port: 0 });
    const response = await fetchOnce(`${server.address}notes.txt`);

    expect(await response.text()).toBe('a </body> b\n');
  });
});
