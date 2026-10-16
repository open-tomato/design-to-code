/**
 * Integration tests for {@link startServer} run end to end over temp copies
 * of three fixture exports: `spaced` (this package's own fixture, the only
 * one with a `.dc.html` page and `.jsx` / `.ts` scripts) and the shared
 * `without-ds` and `nested` fixtures from `pipeline/assess/fixtures`.
 *
 * Each fixture is discovered into a real `discovery.json` first, so the
 * "every page answers 200" test walks the same page list the serve verb
 * itself would refuse to start without. Fixtures are tracked and must not
 * be mutated, so every test copies the fixture it exercises into a fresh
 * temporary directory first.
 *
 * The `403` tests write a raw request line over a `node:net` socket: `fetch`
 * and `curl` without `--path-as-is` normalize `..` client-side, so they
 * could never exercise {@link resolveRequestPath}'s containment check.
 *
 * @packageDocumentation
 */

import type { RunningServer } from './server.ts';
import type { DiscoveryReport } from '../assess/schema.ts';

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { discover, discoveryPath, writeDiscovery } from '../assess/discover.ts';

import { contentTypeFor } from './paths.ts';
import { SERVE_HOST, startServer } from './server.ts';

/** One fixture this suite serves, and the non-HTML file it checks byte for byte. */
interface ServedFixture {
  /** The fixture's directory name. */
  readonly name: string;
  /** The directory holding `name` as a subdirectory. */
  readonly fixturesDir: string;
  /** A non-HTML file's path, relative to the fixture root, to compare on disk. */
  readonly nonHtmlFile: string;
}

const SERVE_FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

const ASSESS_FIXTURES_DIR = join(import.meta.dirname, '..', 'assess', 'fixtures');

const FIXTURES: readonly ServedFixture[] = [
  { name: 'spaced', fixturesDir: SERVE_FIXTURES_DIR, nonHtmlFile: 'app parts/shared.js' },
  { name: 'without-ds', fixturesDir: ASSESS_FIXTURES_DIR, nonHtmlFile: 'app.js' },
  { name: 'nested', fixturesDir: ASSESS_FIXTURES_DIR, nonHtmlFile: 'shared/base.css' },
];

const NOW = new Date('2026-09-30T12:00:00.000Z');

let workDir: string;
let running: RunningServer[];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-serve-server-integration-test-'));
  running = [];
});

afterEach(async () => {
  await Promise.all(running.map((server) => server.stop()));
  rmSync(workDir, { recursive: true, force: true });
});

/** Copies `fixture` into a fresh subdirectory of `workDir`. */
function copyFixture(fixture: ServedFixture): string {
  const target = join(workDir, fixture.name);

  cpSync(join(fixture.fixturesDir, fixture.name), target, { recursive: true });

  return target;
}

/** Discovers `sourceDir` and writes `discovery.json`, returning it as read back from disk. */
function discoverAndWrite(sourceDir: string): DiscoveryReport {
  writeDiscovery(sourceDir, discover(sourceDir, { now: NOW }));

  return JSON.parse(readFileSync(discoveryPath(sourceDir), 'utf8')) as DiscoveryReport;
}

/**
 * Fetches `url` with `Connection: close`, so the underlying socket is
 * never pooled for reuse across the fresh server instance the next test's
 * `beforeEach` may bind to the same port.
 */
function fetchOnce(url: string): Promise<Response> {
  return fetch(url, { headers: { connection: 'close' } });
}

async function start(sourceDir: string): Promise<RunningServer> {
  const server = await startServer({ sourceDir, env: {}, port: 0 });

  running.push(server);

  return server;
}

/** Percent-encodes each segment of a POSIX path relative to `source.dir`. */
function encodePath(relativePath: string): string {
  return relativePath
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

/**
 * Writes `GET <rawTarget> HTTP/1.1` over a raw socket, bypassing any
 * client-side path normalization, and resolves to the response's status
 * code.
 */
function rawGetStatus(port: number, rawTarget: string): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ host: SERVE_HOST, port });
    let response = '';

    socket.on('connect', () => {
      socket.write(`GET ${rawTarget} HTTP/1.1\r\nHost: ${SERVE_HOST}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('latin1');
    });
    socket.on('error', rejectPromise);
    socket.on('end', () => {
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(response);

      if (!match) {
        rejectPromise(new Error(`no status line in raw response: ${JSON.stringify(response)}`));

        return;
      }

      resolvePromise(Number(match[1]));
    });
  });
}

describe.each(FIXTURES)('startServer over the $name fixture', (fixture) => {
  test('answers 200 for every page discovery.json lists, by its percent-encoded path', async () => {
    const sourceDir = copyFixture(fixture);
    const report = discoverAndWrite(sourceDir);
    const server = await start(sourceDir);

    expect(report.pages.length).toBeGreaterThan(0);

    for (const page of report.pages) {
      const response = await fetchOnce(`${server.address}${encodePath(page.path)}`);

      expect(response.status, page.path).toBe(200);
    }
  });

  test('serves a non-HTML file byte for byte, matching the file on disk', async () => {
    const sourceDir = copyFixture(fixture);
    const server = await start(sourceDir);
    const response = await fetchOnce(`${server.address}${encodePath(fixture.nonHtmlFile)}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(contentTypeFor(fixture.nonHtmlFile));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      readFileSync(join(sourceDir, ...fixture.nonHtmlFile.split('/'))),
    );
  });
});

describe('two concurrent port 0 servers', () => {
  test('stopping one rejects requests to its address while the other still answers its own files', async () => {
    const [spaced, nested] = [FIXTURES[0]!, FIXTURES[2]!];
    const stoppedServer = await start(copyFixture(spaced));
    const survivingDir = copyFixture(nested);
    const survivor = await start(survivingDir);

    expect(stoppedServer.port).not.toBe(survivor.port);
    expect((await fetchOnce(`${stoppedServer.address}${encodePath(spaced.nonHtmlFile)}`)).status).toBe(200);

    await stoppedServer.stop();

    await expect(fetchOnce(`${stoppedServer.address}${encodePath(spaced.nonHtmlFile)}`)).rejects.toThrow();

    const response = await fetchOnce(`${survivor.address}${encodePath(nested.nonHtmlFile)}`);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      readFileSync(join(survivingDir, ...nested.nonHtmlFile.split('/'))),
    );
  });
});

describe('startServer content types over the spaced fixture', () => {
  test.each([
    ['Rafa Portal.dc.html', 'text/html; charset=utf-8'],
    ['app parts/Card.jsx', 'text/javascript; charset=utf-8'],
    ['app parts/format.ts', 'text/javascript; charset=utf-8'],
  ])('%s answers content-type %s', async (relativePath, expectedContentType) => {
    const sourceDir = copyFixture(FIXTURES[0]!);
    const server = await start(sourceDir);
    const response = await fetchOnce(`${server.address}${encodePath(relativePath)}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(expectedContentType);
  });
});

describe('startServer raw-socket path refusals', () => {
  test('answers 403 for /../package.json and /..%2fpackage.json', async () => {
    const sourceDir = copyFixture(FIXTURES[0]!);
    const server = await start(sourceDir);

    expect(await rawGetStatus(server.port, '/../package.json')).toBe(403);
    expect(await rawGetStatus(server.port, '/..%2fpackage.json')).toBe(403);
  });
});
