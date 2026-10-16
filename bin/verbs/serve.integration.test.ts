/**
 * Tests for the `serve` verb's test-only `port` option, called directly
 * over a temporary project root with a copy of the spaced serve fixture.
 *
 * The option is shown to reach `startServer` by pairing it with a
 * `D2C_PORT` that `startServer` refuses: the server only starts when the
 * option outranks the variable. A control runs the same environment with
 * no `port` and gets the refusal, so the check could have failed.
 *
 * @packageDocumentation
 */

import type { CliResult } from './result.ts';
import type { PageChecker } from './serve.ts';

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { discover, writeDiscovery } from '../../pipeline/assess/discover.ts';
import { OS_ASSIGNED_PORT } from '../../pipeline/serve/port.ts';
import { serveRecordPath } from '../../pipeline/serve/serve-record.ts';

import { runServe } from './serve.ts';

const SLUG = 'homepage';

const SOURCE_DIR = `design/${SLUG}`;

/** A page the spaced fixture holds. */
const PAGE = 'Rafa Portal.dc.html';

const FIXTURE = join(import.meta.dirname, '..', '..', 'pipeline', 'serve', 'fixtures', 'spaced');

/** An environment whose `D2C_PORT` `startServer` refuses with a `ServePortError`. */
const REFUSED_PORT_ENV = { D2C_PROJECT: SLUG, D2C_PORT: 'not-a-port' };

/** Every fetch closes its socket, so none is pooled across server instances. */
const FETCH_INIT = { headers: { Connection: 'close' } } as const;

let rootDir: string;

/** The stop handles of servers a test started, stopped after it. */
let stops: (() => Promise<void>)[];

/** The project's `source.dir`, absolute under the temporary root. */
function sourceDir(): string {
  return join(rootDir, SOURCE_DIR);
}

/** A checker stub that must never run. */
function unusedChecker() {
  return vi.fn<PageChecker>(async () => {
    throw new Error('the checker must not run');
  });
}

/** Records the stop handle of a result that carries one. */
function track(result: CliResult): CliResult {
  if (result.stop !== undefined) {
    stops.push(result.stop);
  }

  return result;
}

/** The port named in a base URL such as `http://127.0.0.1:5123/`. */
function portOf(address: string): number {
  return Number(new URL(address).port);
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'd2c-verbs-serve-test-'));
  stops = [];
  cpSync(FIXTURE, sourceDir(), { recursive: true });
  writeDiscovery(sourceDir(), discover(sourceDir()));
  mkdirSync(join(rootDir, 'projects'), { recursive: true });
  writeFileSync(join(rootDir, 'projects', `${SLUG}.json`), JSON.stringify({ slug: SLUG, source: { dir: SOURCE_DIR } }));
});

afterEach(async () => {
  await Promise.all(stops.map((stop) => stop()));
  rmSync(rootDir, { recursive: true, force: true });
});

describe('runServe with the test-only port option', () => {
  test('control: with no port, the refused D2C_PORT reaches startServer and fails there', async () => {
    const result = track(await runServe({ check: false }, {
      env: REFUSED_PORT_ENV,
      rootDir,
      checkPages: unusedChecker(),
    }));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^d2c serve: D2C_PORT must be an integer/);
    expect(result.stop).toBeUndefined();
  });

  test('port 0 reaches startServer over a refused D2C_PORT and serves on an OS-assigned port', async () => {
    const result = track(await runServe({ check: false }, {
      env: REFUSED_PORT_ENV,
      rootDir,
      checkPages: unusedChecker(),
      port: OS_ASSIGNED_PORT,
    }));
    const address = /at (http:\S+)\n$/.exec(result.stdout)?.[1] ?? '';

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(portOf(address)).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(serveRecordPath(sourceDir()), 'utf8'))).toMatchObject({ address });
    expect((await fetch(`${address}${encodeURIComponent(PAGE)}`, FETCH_INIT)).status).toBe(200);
  });

  test('--check passes port 0 to its server over a refused D2C_PORT', async () => {
    const addresses: string[] = [];
    const checker = vi.fn<PageChecker>(async (options) => {
      addresses.push(options.address);

      return { generatedAt: new Date().toISOString(), address: options.address, pages: [] };
    });

    const result = await runServe({ check: true }, {
      env: REFUSED_PORT_ENV,
      rootDir,
      checkPages: checker,
      port: OS_ASSIGNED_PORT,
    });

    expect(result.exitCode).toBe(0);
    expect(checker).toHaveBeenCalledTimes(1);
    expect(addresses).toHaveLength(1);
    expect(portOf(addresses[0] ?? '')).toBeGreaterThan(0);
  });
});
