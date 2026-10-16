/**
 * Tests for `confirm.ts` over temporary copies of the `spaced` fixture,
 * each given an import record and a `discovery.json` at test time.
 *
 * `runConfirm` starts a real server over the copy, but no browser runs:
 * the `serve --check` page checker, the page opener, the prompter and the
 * share-link comparer are stubs that record their calls in one shared log,
 * so the order of what was printed, opened and asked can be read back.
 *
 * The runs that leave pages unconfirmed are paired with the `y` run over
 * the same stubs, which writes both pages, so an empty `confirmed.json`
 * means the answer was refused rather than that nothing was ever written.
 * The fixture is tracked and never modified: every test copies it first.
 *
 * @packageDocumentation
 */

import type { ConfirmOptions, OpenedPage, ShareLinkComparer } from './confirm.ts';
import type { ConfirmedEntry } from './confirmed.ts';
import type { PageScore, ShareLinkAccess } from './share-link.ts';
import type { CheckPagesOptions, ServeCheckReport } from '../serve/check.ts';

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { discover, writeDiscovery } from '../assess/discover.ts';
import { writeImportRecord } from '../import/record.ts';
import { checkUrl } from '../serve/check.ts';

import {
  confirmQuestion,
  ConfirmRefusedError,
  DEFAULT_CONFIRM_VIEWPORT,
  findingsText,
  runConfirm,
} from './confirm.ts';
import { confirmedPath, readConfirmed, unconfirmedPages, writeConfirmed } from './confirmed.ts';
import { MissingImportRecordError, readImportHash } from './key.ts';

const SPACED_FIXTURE = join(import.meta.dirname, '..', 'serve', 'fixtures', 'spaced');

/** The fixture's pages, in the order `keptPages` sorts them. */
const CHANGED_PAGE = 'Rafa Portal v2.dc.html';

const MATCHING_PAGE = 'Rafa Portal.dc.html';

const BASELINE_DIR = 'baselines/test';

const SHARE_LINK = 'https://claude.ai/design/p/stand-in/';

const CONFIRMED_AT = new Date('2026-09-30T12:00:00.000Z');

const CONSOLE_ERROR = 'ReferenceError: portal is not defined';

const MISSING_ASSET = 'http://127.0.0.1:5123/app%20parts/missing.png';

/** A temp copy of the fixture with its import record and discovery report. */
interface Workspace {
  readonly rootDir: string;
  readonly sourceDir: string;
  readonly baselineRoot: string;
  readonly importHash: string;
}

/** The stubs of one run and the log they share. */
interface Stubs {
  readonly log: string[];
  readonly checkPages: ReturnType<typeof vi.fn<(options: CheckPagesOptions) => Promise<ServeCheckReport>>>;
  readonly openPage: ReturnType<typeof vi.fn<ConfirmOptions['openPage']>>;
  readonly prompt: ReturnType<typeof vi.fn<(question: string) => Promise<string>>>;
  readonly print: (text: string) => void;
}

const workDirs: string[] = [];

afterEach(() => {
  workDirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});

/** Copies the fixture, and records and assesses it. */
function workspace(): Workspace {
  const rootDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-baseline-confirm-test-'));
  const sourceDir = join(rootDir, 'spaced');

  workDirs.push(rootDir);
  cpSync(SPACED_FIXTURE, sourceDir, { recursive: true });
  writeImportRecord({ sourceDir, kind: 'folder', originalPath: SPACED_FIXTURE });
  writeDiscovery(sourceDir, discover(sourceDir));

  return { rootDir, sourceDir, baselineRoot: join(rootDir, BASELINE_DIR), importHash: readImportHash(sourceDir) };
}

/** A report with a console error and a failed request on the changed page only. */
function report(address: string): ServeCheckReport {
  return {
    generatedAt: CONFIRMED_AT.toISOString(),
    address,
    pages: [
      { path: CHANGED_PAGE, consoleErrors: [CONSOLE_ERROR], failedRequests: [{ url: MISSING_ASSET, status: 404 }], blank: false },
      { path: MATCHING_PAGE, consoleErrors: [], failedRequests: [], blank: false },
    ],
  };
}

/** Stubs whose prompter answers `answer` to every question. */
function stubs(answer: string): Stubs {
  const log: string[] = [];

  return {
    log,
    checkPages: vi.fn(async (options: CheckPagesOptions) => {
      log.push('check');

      return report(options.address);
    }),
    openPage: vi.fn(async ({ page }): Promise<OpenedPage> => {
      log.push(`open ${page}`);

      return {
        close: async () => {
          log.push(`close ${page}`);
        },
      };
    }),
    prompt: vi.fn(async (question: string) => {
      log.push(`ask ${question}`);

      return answer;
    }),
    print: (text) => {
      log.push(`print ${text}`);
    },
  };
}

/** A comparer whose link reads as `access` and whose `score` answers `scores[page]`, or throws when it holds an `Error`. */
function comparer(
  scores: Readonly<Record<string, Error | PageScore>>,
  access: ShareLinkAccess = { status: 'public' },
): ShareLinkComparer {
  return {
    check: vi.fn(async () => access),
    score: vi.fn(async (target) => {
      const scored = scores[target.path];

      if (scored === undefined || scored instanceof Error) {
        throw scored ?? new Error(`no stub score for ${target.path}`);
      }

      return scored;
    }),
    close: vi.fn(async () => undefined),
  };
}

/** A passing or failing `scored` result. */
function scored(score: number, passed: boolean): PageScore {
  return { status: 'scored', view: SHARE_LINK, score, passed, region: { x: 0, y: 0, width: 10, height: 10 } };
}

/** Run options over `space` with `stub`'s seams and no share link. */
function options(space: Workspace, stub: Stubs, overrides: Partial<ConfirmOptions> = {}): ConfirmOptions {
  return {
    sourceDir: space.sourceDir,
    baselineDir: BASELINE_DIR,
    rootDir: space.rootDir,
    pages: undefined,
    viewports: undefined,
    shareLink: undefined,
    openPage: stub.openPage,
    prompt: stub.prompt,
    print: stub.print,
    checkPages: stub.checkPages,
    env: {},
    now: () => CONFIRMED_AT,
    ...overrides,
  };
}

/** The questions the prompter was asked, in order. */
function questions(stub: Stubs): readonly string[] {
  return stub.prompt.mock.calls.map(([question]) => question);
}

describe('runConfirm by the person', () => {
  test('records a `y` answer as `person` under the import hash for every kept page', async () => {
    const space = workspace();
    const stub = stubs('y');

    const result = await runConfirm(options(space, stub));

    const expected: ConfirmedEntry[] = [CHANGED_PAGE, MATCHING_PAGE].map((page) => ({
      page,
      confirmedAt: CONFIRMED_AT.toISOString(),
      by: 'person',
      importHash: space.importHash,
    }));

    expect(readConfirmed(space.baselineRoot)).toEqual(expected);
    expect(result.entries).toEqual(expected);
    expect(result.pages.map((page) => page.status)).toEqual(['confirmed', 'confirmed']);
    expect(questions(stub)).toEqual([confirmQuestion(CHANGED_PAGE), confirmQuestion(MATCHING_PAGE)]);
    expect(stub.checkPages).toHaveBeenCalledTimes(1);
    expect(stub.log).toContain(`close ${MATCHING_PAGE}`);
  });

  test('opens each page at its served URL with the nav bar off', async () => {
    const space = workspace();
    const stub = stubs('Y ');

    await runConfirm(options(space, stub));

    const address = stub.checkPages.mock.calls[0]?.[0].address ?? '';

    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(stub.openPage.mock.calls.map(([target]) => target)).toEqual([
      { page: CHANGED_PAGE, url: checkUrl(address, CHANGED_PAGE) },
      { page: MATCHING_PAGE, url: checkUrl(address, MATCHING_PAGE) },
    ]);
    expect(readConfirmed(space.baselineRoot)).toHaveLength(2);
  });

  test('leaves every page unconfirmed on an empty answer, removing a current entry', async () => {
    const space = workspace();
    const stub = stubs('');

    writeConfirmed(space.baselineRoot, [
      { page: MATCHING_PAGE, confirmedAt: CONFIRMED_AT.toISOString(), by: 'person', importHash: space.importHash },
    ]);

    const result = await runConfirm(options(space, stub));

    expect(questions(stub)).toHaveLength(2);
    expect(existsSync(confirmedPath(space.baselineRoot))).toBe(true);
    expect(readConfirmed(space.baselineRoot)).toEqual([]);
    expect(unconfirmedPages([CHANGED_PAGE, MATCHING_PAGE], result.entries, space.importHash))
      .toEqual([CHANGED_PAGE, MATCHING_PAGE]);
    expect(result.pages).toEqual([
      { page: CHANGED_PAGE, status: 'unconfirmed' },
      { page: MATCHING_PAGE, status: 'unconfirmed' },
    ]);
  });

  test('prints each page\'s findings before opening it and asking', async () => {
    const space = workspace();
    const stub = stubs('y');

    await runConfirm(options(space, stub));

    const findings = stub.log.indexOf(`print ${findingsText(CHANGED_PAGE, report('').pages[0])}`);
    const opened = stub.log.indexOf(`open ${CHANGED_PAGE}`);
    const asked = stub.log.indexOf(`ask ${confirmQuestion(CHANGED_PAGE)}`);

    expect(stub.log[0]).toMatch(/^print No source\.shareLink/);
    expect(stub.log[1]).toBe('check');
    expect(findings).toBeGreaterThan(1);
    expect(opened).toBe(findings + 1);
    expect(asked).toBe(opened + 1);
    expect(stub.log[findings]).toContain(CONSOLE_ERROR);
    expect(stub.log[findings]).toContain(`${MISSING_ASSET} (status 404)`);
    expect(stub.log.indexOf(`print ${findingsText(MATCHING_PAGE, report('').pages[1])}`)).toBeGreaterThan(asked);
  });
});

describe('runConfirm by the share link', () => {
  test('records a passing score as `share-link` without asking', async () => {
    const space = workspace();
    const stub = stubs('y');
    const compare = comparer({ [CHANGED_PAGE]: scored(0.003, true), [MATCHING_PAGE]: scored(0, true) });

    const result = await runConfirm(options(space, stub, { shareLink: SHARE_LINK, openComparer: async () => compare }));

    expect(stub.prompt).not.toHaveBeenCalled();
    expect(stub.checkPages).not.toHaveBeenCalled();
    expect(compare.score).toHaveBeenCalledWith(expect.objectContaining({ shareLink: SHARE_LINK, viewport: DEFAULT_CONFIRM_VIEWPORT }));
    expect(compare.close).toHaveBeenCalledTimes(1);
    expect(result.entries.map((entry) => [entry.page, entry.by, 'score' in entry
      ? entry.score
      : undefined])).toEqual([
      [CHANGED_PAGE, 'share-link', 0.003],
      [MATCHING_PAGE, 'share-link', 0],
    ]);
  });

  test.each<[string, Error | PageScore]>([
    ['a score over the threshold', scored(0.2, false)],
    ['a view with no frame', { status: 'frame-not-found', view: SHARE_LINK }],
    ['an unreachable view', { status: 'view-unreachable', view: SHARE_LINK, reason: 'cross-origin', detail: 'https://login.example' }],
    ['a comparison that throws', new Error('served page did not settle')],
  ])('falls back to the prompter for %s', async (_label, failure) => {
    const space = workspace();
    const stub = stubs('y');
    const compare = comparer({ [CHANGED_PAGE]: failure, [MATCHING_PAGE]: scored(0.004, true) });
    const viewport = { name: 'wide', width: 1440, height: 900 };

    await runConfirm(options(space, stub, { shareLink: SHARE_LINK, viewports: [viewport], openComparer: async () => compare }));

    expect(compare.score).toHaveBeenCalledWith(expect.objectContaining({ path: CHANGED_PAGE, viewport }));
    expect(questions(stub)).toEqual([confirmQuestion(CHANGED_PAGE)]);
    expect(stub.log.find((line) => line.startsWith(`print ${CHANGED_PAGE}: `))).toMatch(/asking a person$/);
    expect(readConfirmed(space.baselineRoot).map((entry) => [entry.page, entry.by])).toEqual([
      [CHANGED_PAGE, 'person'],
      [MATCHING_PAGE, 'share-link'],
    ]);
  });

  test('asks about every page without scoring when the link is not public', async () => {
    const space = workspace();
    const stub = stubs('y');
    const compare = comparer({}, { status: 'not-public', reason: 'cross-origin', detail: 'https://login.example' });

    await runConfirm(options(space, stub, { shareLink: SHARE_LINK, openComparer: async () => compare }));

    expect(compare.score).not.toHaveBeenCalled();
    expect(compare.close).toHaveBeenCalledTimes(1);
    expect(questions(stub)).toEqual([confirmQuestion(CHANGED_PAGE), confirmQuestion(MATCHING_PAGE)]);
  });
});

describe('runConfirm refusals', () => {
  test('refuses with no import record before checking, opening or asking', async () => {
    const space = workspace();
    const stub = stubs('y');

    rmSync(join(space.sourceDir, '.import'), { recursive: true });

    await expect(runConfirm(options(space, stub))).rejects.toBeInstanceOf(MissingImportRecordError);
    expect(stub.log).toEqual([]);
    expect(existsSync(space.baselineRoot)).toBe(false);
  });

  test('refuses when every page is discarded', async () => {
    const space = workspace();
    const stub = stubs('y');

    await expect(runConfirm(options(space, stub, { pages: { discard: [CHANGED_PAGE, MATCHING_PAGE] } })))
      .rejects.toBeInstanceOf(ConfirmRefusedError);
    expect(stub.log).toEqual([]);
  });
});

describe('findingsText', () => {
  test('lists each finding under the page path', () => {
    const [changed] = report('').pages;

    expect(findingsText(CHANGED_PAGE, changed)).toBe([
      CHANGED_PAGE,
      '  console errors (1):',
      `    - ${CONSOLE_ERROR}`,
      '  failed requests (1):',
      `    - ${MISSING_ASSET} (status 404)`,
      '  blank: no',
    ].join('\n'));
  });

  test('says none for a clean page and names a missing reading', () => {
    expect(findingsText(MATCHING_PAGE, { path: MATCHING_PAGE, consoleErrors: [], failedRequests: [{ url: 'a.js', reason: 'net::ERR_FAILED' }], blank: true }))
      .toBe(`${MATCHING_PAGE}\n  console errors: none\n  failed requests (1):\n    - a.js (net::ERR_FAILED)\n  blank: yes`);
    expect(findingsText(MATCHING_PAGE, undefined)).toBe(`${MATCHING_PAGE}\n  serve --check: no reading for this page`);
  });
});
