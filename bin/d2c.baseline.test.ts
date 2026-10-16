/**
 * Tests for the `baseline` verb through `run`, over temporary copies of the
 * `spaced` fixture given an import record and a `discovery.json` at test
 * time.
 *
 * No browser runs: the page checker, the page opener and the prompter are
 * stubs. The refusals are each paired with a run that gets past the same
 * check, so an exit 1 is the refusal named and not a setup mistake: the
 * missing import record with confirm writing `confirmed.json` over the same
 * workspace, and the capture refusals with one another (unset `viewports`
 * refuses before the confirmation check that names the page).
 *
 * @packageDocumentation
 */

import type { PageChecker } from './verbs/serve.ts';
import type { OpenedPage, PageOpener } from '../pipeline/baseline/confirm.ts';

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { discover, writeDiscovery } from '../pipeline/assess/discover.ts';
import { confirmedPath, readConfirmed } from '../pipeline/baseline/confirmed.ts';
import { readImportHash } from '../pipeline/baseline/key.ts';
import { CONFIRM_COMMAND } from '../pipeline/baseline/run-capture.ts';
import { recordPath, writeImportRecord } from '../pipeline/import/record.ts';

import { main, run, USAGE } from './d2c';

const SLUG = 'homepage';

const ENV = { D2C_PROJECT: SLUG, D2C_PORT: undefined };

const SOURCE_DIR = `design/${SLUG}`;

const BASELINE_DIR = `baselines/${SLUG}`;

const FIXTURE = join(import.meta.dirname, '..', 'pipeline', 'serve', 'fixtures', 'spaced');

/** The fixture's pages, sorted by path as `keptPages` returns them. */
const PAGES = ['Rafa Portal v2.dc.html', 'Rafa Portal.dc.html'] as const;

const VIEWPORTS = [{ name: 'desktop', width: 1280, height: 800 }];

const TMP_PREFIX = 'd2c-bin-d2c-baseline-test-';

let rootDir: string;

/** The project's `source.dir`, absolute under the temporary root. */
function sourceDir(): string {
  return join(rootDir, SOURCE_DIR);
}

/** The project's `baselineDir`, absolute under the temporary root. */
function baselineRoot(): string {
  return join(rootDir, BASELINE_DIR);
}

/** Writes `projects/<slug>.json` under the temporary root. */
function writeProject(fields: Record<string, unknown> = {}): void {
  mkdirSync(join(rootDir, 'projects'), { recursive: true });
  writeFileSync(
    join(rootDir, 'projects', `${SLUG}.json`),
    JSON.stringify({ slug: SLUG, source: { dir: SOURCE_DIR }, ...fields }),
  );
}

/** A checker stub reporting every page clean. */
function cleanChecker() {
  return vi.fn<PageChecker>(async ({ address }) => ({
    generatedAt: new Date().toISOString(),
    address,
    pages: PAGES.map((path) => ({ path, consoleErrors: [], failedRequests: [], blank: false })),
  }));
}

/** An opener stub whose pages close without a browser. */
function stubOpener() {
  return vi.fn<PageOpener>(async (): Promise<OpenedPage> => ({ close: async () => undefined }));
}

/** A prompter stub answering `answer` to every question. */
function stubPrompter(answer: string) {
  return vi.fn(async (question: string) => {
    expect(typeof question).toBe('string');

    return answer;
  });
}

/** Seams that must never run. */
function unusedSeams() {
  const fail = async (): Promise<never> => {
    throw new Error('this seam must not run');
  };

  return { checkPages: vi.fn<PageChecker>(fail), openPage: vi.fn<PageOpener>(fail), prompt: vi.fn(fail) };
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  cpSync(FIXTURE, sourceDir(), { recursive: true });
  writeImportRecord({ sourceDir: sourceDir(), kind: 'folder', originalPath: FIXTURE });
  writeDiscovery(sourceDir(), discover(sourceDir()));
  writeProject({ viewports: VIEWPORTS });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('run baseline: arguments', () => {
  test.each([
    [[], /^d2c baseline: missing subcommand; expected one of confirm, capture\n/],
    [['verify'], /^d2c baseline: unknown subcommand 'verify'; expected one of confirm, capture\n/],
  ])('rejects %j with the usage text and runs nothing', async (args, message) => {
    const seams = unusedSeams();
    const result = await run(['baseline', ...args], { env: ENV, rootDir, ...seams });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain(USAGE);
    expect(seams.checkPages).not.toHaveBeenCalled();
    expect(existsSync(baselineRoot())).toBe(false);
  });

  test('lists both subcommands in the usage text', () => {
    expect(USAGE).toContain('baseline confirm');
    expect(USAGE).toContain('baseline capture');
  });
});

describe('run baseline: refusals', () => {
  test.each(['confirm', 'capture'])('%s refuses without an import record, naming the import command', async (subcommand) => {
    rmSync(recordPath(sourceDir()));
    const seams = unusedSeams();
    const result = await run(['baseline', subcommand], { env: ENV, rootDir, ...seams });

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `d2c baseline: no import record at ${recordPath(sourceDir())}; run \`bun run d2c import\` first\n`,
    });
    expect(seams.openPage).not.toHaveBeenCalled();
    expect(existsSync(baselineRoot())).toBe(false);
  });

  test('capture refuses when viewports is unset, before the confirmation check', async () => {
    writeProject();
    const result = await run(['baseline', 'capture'], { env: ENV, rootDir, ...unusedSeams() });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^d2c baseline: `viewports` is not set in the project config/);
    expect(result.stderr).not.toContain(PAGES[0]);
    expect(existsSync(baselineRoot())).toBe(false);
  });

  test('capture exits 1 naming the unconfirmed pages, writing nothing', async () => {
    const result = await run(['baseline', 'capture'], { env: ENV, rootDir, ...unusedSeams() });

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `d2c baseline: 2 of 2 kept pages have no confirmation for the current import: ${PAGES.join(', ')}; run \`${CONFIRM_COMMAND}\` first\n`,
    });
    expect(existsSync(baselineRoot())).toBe(false);
  });

  test('main prints a baseline refusal without a stack and returns 1', async () => {
    rmSync(recordPath(sourceDir()));
    const stderr: string[] = [];
    const exitCode = await main(['baseline', 'capture'], { env: ENV, rootDir, ...unusedSeams() }, {
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('')).toMatch(/^d2c baseline: no import record at /);
    expect(stderr.join('')).not.toMatch(/\n\s+at /);
  });
});

describe('run baseline confirm', () => {
  test('writes confirmed.json through the stub prompter, findings shown with each question', async () => {
    const checkPages = cleanChecker();
    const openPage = stubOpener();
    const prompt = stubPrompter('y');
    const result = await run(['baseline', 'confirm'], { env: ENV, rootDir, checkPages, openPage, prompt });

    expect(result).toEqual({
      exitCode: 0,
      stdout: `d2c baseline: confirmed 2 of 2 kept pages; wrote ${confirmedPath(baselineRoot())}\n`,
      stderr: '',
    });
    expect(prompt.mock.calls.map(([question]) => question.split('\n').at(-1))).toEqual(
      PAGES.map((page) => `Does ${page} work as in Claude Design? [y/N] `),
    );
    expect(prompt.mock.calls[0]?.[0]).toContain(`${PAGES[0]}\n  console errors: none`);
    expect(openPage.mock.calls.map(([target]) => target.page)).toEqual([...PAGES]);
    expect(checkPages).toHaveBeenCalledTimes(1);
    expect(readConfirmed(baselineRoot()).map(({ page, by, importHash }) => ({ page, by, importHash }))).toEqual(
      PAGES.map((page) => ({ page, by: 'person', importHash: readImportHash(sourceDir()) })),
    );
  });

  test('exits 1 naming the pages the person did not confirm, and capture then names them', async () => {
    const prompt = vi.fn(async (question: string) => (question.includes(PAGES[0])
      ? 'y'
      : 'n'));
    const result = await run(['baseline', 'confirm'], {
      env: ENV,
      rootDir,
      checkPages: cleanChecker(),
      openPage: stubOpener(),
      prompt,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(`d2c baseline: confirmed 1 of 2 kept pages; wrote ${confirmedPath(baselineRoot())}\n`);
    expect(result.stderr).toBe(`d2c baseline: 1 kept pages left unconfirmed: ${PAGES[1]}\n`);
    expect(readConfirmed(baselineRoot()).map((entry) => entry.page)).toEqual([PAGES[0]]);

    const captured = await run(['baseline', 'capture'], { env: ENV, rootDir, ...unusedSeams() });

    expect(captured.exitCode).toBe(1);
    expect(captured.stderr).toContain(`1 of 2 kept pages have no confirmation for the current import: ${PAGES[1]};`);
    expect(readdirSync(baselineRoot())).toEqual(['confirmed.json']);
  });
});
