import type { CliOptions } from './d2c';
import type { PageChecker } from './verbs/serve.ts';
import type { ServeCheckReport } from '../pipeline/serve/check.ts';

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { discover, writeDiscovery } from '../pipeline/assess/discover.ts';
import { serveCheckPath, serveCheckReportSchema, writeServeCheck } from '../pipeline/serve/check.ts';
import { OS_ASSIGNED_PORT } from '../pipeline/serve/port.ts';
import { serveRecordPath } from '../pipeline/serve/serve-record.ts';

import { run, USAGE } from './d2c';
import { DISCOVERY_COMMAND } from './verbs/serve.ts';

const SLUG = 'homepage';

const ENV = { D2C_PROJECT: SLUG };

const SOURCE_DIR = `design/${SLUG}`;

const FIXTURE = join(import.meta.dirname, '..', 'pipeline', 'serve', 'fixtures', 'spaced');

const PAGE = 'Rafa Portal.dc.html';

/** The line `serve` prints, capturing the address. */
const SERVING_LINE = new RegExp(`^d2c serve: serving ${SOURCE_DIR} at (http://127\\.0\\.0\\.1:\\d+/)\\n$`);

/** Every fetch closes its socket, so none is pooled across server instances. */
const FETCH_INIT = { headers: { Connection: 'close' } } as const;

let rootDir: string;

/** The stop handles of servers a test started, stopped after it. */
let stops: (() => Promise<void>)[];

/** The project's `source.dir`, absolute under the temporary root. */
function sourceDir(): string {
  return join(rootDir, SOURCE_DIR);
}

/** Writes `projects/<slug>.json` under the temporary root. */
function writeProject(content: unknown): void {
  mkdirSync(join(rootDir, 'projects'), { recursive: true });
  writeFileSync(join(rootDir, 'projects', `${SLUG}.json`), JSON.stringify(content));
}

/** A checker stub that must never run. */
function unusedChecker() {
  return vi.fn<PageChecker>(async () => {
    throw new Error('the checker must not run');
  });
}

/**
 * Runs the `serve` verb against the temporary root, recording any stop handle.
 * By default the server binds a port the OS assigns, so no two test files
 * compete for one; pass `{ env }` alone to have `D2C_PORT` decide instead.
 */
async function runServe(
  args: readonly string[],
  checkPages: PageChecker,
  overrides: Pick<CliOptions, 'env' | 'port'> = { env: ENV, port: OS_ASSIGNED_PORT },
) {
  const result = await run(['serve', ...args], { ...overrides, rootDir, checkPages });

  if (result.stop !== undefined) {
    stops.push(result.stop);
  }

  return result;
}

/** Whether a GET of `url` answers at all. */
async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, FETCH_INIT);

    return true;
  } catch {
    return false;
  }
}

/** A checker stub that fetches a page while it runs and writes a report with `problem` on it. */
function writingChecker(problem: Partial<ServeCheckReport['pages'][number]> = {}) {
  const statuses: number[] = [];
  const checker = vi.fn<PageChecker>(async ({ sourceDir: dir, address }) => {
    const response = await fetch(`${address}${encodeURIComponent(PAGE)}?d2c-nav=0`, FETCH_INIT);

    statuses.push(response.status);

    return writeServeCheck(dir, {
      generatedAt: new Date().toISOString(),
      address,
      pages: [{ path: PAGE, consoleErrors: [], failedRequests: [], blank: false, ...problem }],
    });
  });

  return { checker, statuses };
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'd2c-bin-d2c-serve-test-'));
  stops = [];
  cpSync(FIXTURE, sourceDir(), { recursive: true });
  writeDiscovery(sourceDir(), discover(sourceDir()));
  writeProject({ slug: SLUG, source: { dir: SOURCE_DIR } });
});

afterEach(async () => {
  await Promise.all(stops.map((stop) => stop()));
  rmSync(rootDir, { recursive: true, force: true });
});

describe('run serve', () => {
  test('rejects an unknown option with the usage text and starts nothing', async () => {
    const checker = unusedChecker();
    const result = await runServe(['--watch'], checker);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^d2c serve: Unknown option '--watch'/);
    expect(result.stderr).toContain(USAGE);
    expect(result.stop).toBeUndefined();
    expect(checker).not.toHaveBeenCalled();
    expect(existsSync(serveRecordPath(sourceDir()))).toBe(false);
  });

  test.each([[[]], [['--check']]])('refuses to start without discovery.json (%j)', async (args) => {
    rmSync(join(sourceDir(), 'discovery.json'));
    const checker = unusedChecker();
    const result = await runServe(args, checker);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `d2c serve: ${SOURCE_DIR}/discovery.json not found; run '${DISCOVERY_COMMAND}' first\n`,
    });
    expect(DISCOVERY_COMMAND).toBe('bun run d2c assess --scripts-only');
    expect(checker).not.toHaveBeenCalled();
    expect(existsSync(serveRecordPath(sourceDir()))).toBe(false);
  });

  test.each(['abc', '0', '65536', '', ' 5123', '05123'])('rejects D2C_PORT=%j', async (port) => {
    const checker = unusedChecker();

    for (const args of [[], ['--check']]) {
      const result = await runServe(args, checker, { env: { ...ENV, D2C_PORT: port } });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^d2c serve: .*D2C_PORT/);
      expect(result.stop).toBeUndefined();
    }

    expect(checker).not.toHaveBeenCalled();
    expect(existsSync(serveRecordPath(sourceDir()))).toBe(false);
  });

  test('prints the address it serves on and stops through the handle', async () => {
    const result = await runServe([], unusedChecker());
    const [, address] = SERVING_LINE.exec(result.stdout) ?? [];

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(address).toBeDefined();

    const response = await fetch(`${address}${encodeURIComponent(PAGE)}`, FETCH_INIT);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(readFileSync(join(sourceDir(), PAGE), 'utf8').slice(0, 40));
    expect(JSON.parse(readFileSync(serveRecordPath(sourceDir()), 'utf8'))).toMatchObject({ address });

    await result.stop?.();

    expect(await answers(`${address}`)).toBe(false);
    expect(existsSync(serveRecordPath(sourceDir()))).toBe(false);
  });

  test('the test-only port reaches the server and outranks a refused D2C_PORT', async () => {
    const env = { ...ENV, D2C_PORT: 'not-a-port' };

    // Control: without the port, the refused D2C_PORT reaches the server and fails the run.
    const refused = await runServe([], unusedChecker(), { env });

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/^d2c serve: D2C_PORT must be an integer/);

    const result = await runServe([], unusedChecker(), { env, port: OS_ASSIGNED_PORT });
    const [, address] = SERVING_LINE.exec(result.stdout) ?? [];

    expect(result.exitCode).toBe(0);
    expect(address).toBeDefined();
    expect(await answers(`${address}`)).toBe(true);
  });

  test('--check exits 0 for a clean report and stops its server', async () => {
    const { checker, statuses } = writingChecker();
    const result = await runServe(['--check'], checker);
    const [options] = checker.mock.calls[0] ?? [];

    expect(result).toEqual({
      exitCode: 0,
      stdout: `d2c serve: checked 1 pages at ${options?.address}; wrote ${SOURCE_DIR}/serve-check.json\n`,
      stderr: '',
    });
    expect(options).toMatchObject({ sourceDir: sourceDir(), pages: undefined });
    expect(statuses).toEqual([200]);
    expect(await answers(`${options?.address}`)).toBe(false);
    expect(existsSync(serveRecordPath(sourceDir()))).toBe(false);
  });

  test('--check passes the config\'s pages to the checker', async () => {
    writeProject({ slug: SLUG, source: { dir: SOURCE_DIR }, pages: { discard: [PAGE] } });
    const { checker } = writingChecker();

    await runServe(['--check'], checker);

    expect(checker.mock.calls[0]?.[0].pages).toEqual({ discard: [PAGE] });
  });

  test.each([
    ['a console error', { consoleErrors: ['boom'] }],
    ['a failed request', { failedRequests: [{ url: 'http://127.0.0.1:1/x.png', status: 404 }] }],
    ['a blank render', { blank: true }],
  ])('--check exits 1 for %s, keeps the report and stops its server', async (_label, problem) => {
    const { checker, statuses } = writingChecker(problem);
    const result = await runServe(['--check'], checker);
    const address = checker.mock.calls[0]?.[0].address;

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`wrote ${SOURCE_DIR}/serve-check.json`);
    expect(result.stderr).toBe(`d2c serve: 1 pages have problems: ${PAGE}\n`);
    expect(result.stop).toBeUndefined();
    expect(statuses).toEqual([200]);

    const report = serveCheckReportSchema.parse(JSON.parse(readFileSync(serveCheckPath(sourceDir()), 'utf8')));

    expect(report.pages[0]).toMatchObject(problem);
    expect(await answers(`${address}`)).toBe(false);
  });

  test('--check stops its server when the checker throws', async () => {
    let address = '';
    const checker = vi.fn<PageChecker>(async (options) => {
      address = options.address;
      throw new Error('chromium is not installed');
    });

    await expect(runServe(['--check'], checker)).rejects.toThrow('chromium is not installed');
    expect(address).not.toBe('');
    expect(await answers(address)).toBe(false);
    expect(existsSync(serveRecordPath(sourceDir()))).toBe(false);
  });
});
