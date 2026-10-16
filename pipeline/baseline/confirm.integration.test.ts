/**
 * End-to-end tests for `confirm.ts`: a temp copy of the `spaced` fixture
 * served by a real {@link startServer}, confirmed against a local
 * `share-link-stand-in.ts` design project rather than any stub comparer, so
 * `runConfirm`'s default headless-Chromium comparer runs for real.
 *
 * A `framed` stand-in wraps an unmodified second copy of the fixture in
 * chrome around an `iframe`, so every kept page's design frame matches the
 * served page and scores under {@link CONFIRM_THRESHOLD}: both pages are
 * confirmed `by: 'share-link'` and the person's opener and prompter are
 * never called. A `frameless` stand-in keeps the chrome but drops the
 * `iframe`, so every page comes back `frame-not-found` and falls back to
 * the person: the opener and prompter, still stubs (a real one would open a
 * headed browser and read a real keypress), are called once per kept page.
 * `serve --check` itself runs for real over the served copy in the person
 * pass, since only the design side is a local stand-in.
 *
 * The fixture is tracked and never modified: every run copies it first.
 *
 * @packageDocumentation
 */

import type { ConfirmOptions, OpenedPage, PageOpener, Prompter } from './confirm.ts';
import type { RunningStandIn } from './share-link-stand-in.ts';
import type { RunningServer } from '../serve/server.ts';

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { discover, writeDiscovery } from '../assess/discover.ts';
import { writeImportRecord } from '../import/record.ts';
import { checkUrl } from '../serve/check.ts';
import { startServer } from '../serve/server.ts';

import { confirmQuestion, runConfirm } from './confirm.ts';
import { readConfirmed } from './confirmed.ts';
import { readImportHash } from './key.ts';
import { startStandIn } from './share-link-stand-in.ts';
import { CONFIRM_THRESHOLD } from './share-link.ts';

const SPACED_FIXTURE = join(import.meta.dirname, '..', 'serve', 'fixtures', 'spaced');

/** The fixture's two pages, in the order `keptPages` sorts them. */
const CHANGED_PAGE = 'Rafa Portal v2.dc.html';

const MATCHING_PAGE = 'Rafa Portal.dc.html';

const BASELINE_DIR = 'baselines/test';

/** A browser launch (the comparer's or `serve --check`'s) plus a couple of page loads. */
const TEST_TIMEOUT_MS = 90_000;

/** A temp copy of the fixture with its import record and discovery report. */
interface Workspace {
  readonly rootDir: string;
  readonly sourceDir: string;
  readonly baselineRoot: string;
  readonly importHash: string;
}

const workDirs: string[] = [];

let design: RunningServer;
let framed: RunningStandIn;
let frameless: RunningStandIn;

beforeAll(async () => {
  const designRoot = mkdtempSync(join(tmpdir(), 'd2c-pipeline-baseline-confirm-integration-design-'));
  const designDir = join(designRoot, 'design');

  workDirs.push(designRoot);
  cpSync(SPACED_FIXTURE, designDir, { recursive: true });

  design = await startServer({ sourceDir: designDir, env: {}, port: 0 });
  framed = await startStandIn({ mode: 'design', designAddress: design.address, frame: true });
  frameless = await startStandIn({ mode: 'design', designAddress: design.address, frame: false });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([framed.stop(), frameless.stop()]);
  await design.stop();
});

afterEach(() => {
  workDirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});

/** A fresh copy of the fixture, recorded and discovered, under its own temp root. */
function workspace(): Workspace {
  const rootDir = mkdtempSync(join(tmpdir(), 'd2c-pipeline-baseline-confirm-integration-test-'));
  const sourceDir = join(rootDir, 'served');

  workDirs.push(rootDir);
  cpSync(SPACED_FIXTURE, sourceDir, { recursive: true });
  writeImportRecord({ sourceDir, kind: 'folder', originalPath: SPACED_FIXTURE });
  writeDiscovery(sourceDir, discover(sourceDir));

  return { rootDir, sourceDir, baselineRoot: join(rootDir, BASELINE_DIR), importHash: readImportHash(sourceDir) };
}

/** The opener and prompter of one run, so a test can read their calls back. */
interface Stubs {
  readonly openPage: ReturnType<typeof vi.fn<PageOpener>>;
  readonly prompt: ReturnType<typeof vi.fn<Prompter>>;
}

/** A stubbed opener that never shows a window, and a prompter that always answers `y`. */
function stubs(): Stubs {
  return {
    openPage: vi.fn(async (): Promise<OpenedPage> => ({ close: async () => undefined })),
    prompt: vi.fn(async () => 'y'),
  };
}

/** Run options over `space`, confirming against `shareLink` with `stub`'s opener and prompter. */
function options(space: Workspace, shareLink: string, stub: Stubs): ConfirmOptions {
  return {
    sourceDir: space.sourceDir,
    baselineDir: BASELINE_DIR,
    rootDir: space.rootDir,
    pages: undefined,
    viewports: undefined,
    shareLink,
    openPage: stub.openPage,
    prompt: stub.prompt,
    print: () => undefined,
  };
}

describe('runConfirm against a real server and the framed share-link stand-in', () => {
  test('confirms every kept page by share link under the threshold without the prompter', async () => {
    const space = workspace();
    const stub = stubs();

    const result = await runConfirm(options(space, framed.shareLink, stub));

    expect(stub.prompt).not.toHaveBeenCalled();
    expect(stub.openPage).not.toHaveBeenCalled();
    expect(result.pages.map((page) => page.status)).toEqual(['confirmed', 'confirmed']);

    const entries = readConfirmed(space.baselineRoot);

    expect(entries.map((entry) => entry.page)).toEqual([CHANGED_PAGE, MATCHING_PAGE]);

    entries.forEach((entry) => {
      expect(entry.by).toBe('share-link');
      expect(entry.importHash).toBe(space.importHash);
      expect('score' in entry && entry.score).toBeLessThan(CONFIRM_THRESHOLD);
    });
  }, TEST_TIMEOUT_MS);
});

describe('runConfirm against a real server and the frameless share-link stand-in', () => {
  test('finds no design frame for any page and asks the person about every one', async () => {
    const space = workspace();
    const stub = stubs();

    const result = await runConfirm(options(space, frameless.shareLink, stub));

    const questions = stub.prompt.mock.calls.map(([question]) => question);
    const opened = stub.openPage.mock.calls.map(([target]) => target);
    const address = opened[0] === undefined
      ? ''
      : new URL(opened[0].url).origin;

    expect(questions).toEqual([confirmQuestion(CHANGED_PAGE), confirmQuestion(MATCHING_PAGE)]);
    expect(opened).toEqual([
      { page: CHANGED_PAGE, url: checkUrl(address, CHANGED_PAGE) },
      { page: MATCHING_PAGE, url: checkUrl(address, MATCHING_PAGE) },
    ]);
    expect(result.pages.map((page) => page.status)).toEqual(['confirmed', 'confirmed']);

    const entries = readConfirmed(space.baselineRoot);

    expect(entries.map((entry) => [entry.page, entry.by])).toEqual([
      [CHANGED_PAGE, 'person'],
      [MATCHING_PAGE, 'person'],
    ]);
  }, TEST_TIMEOUT_MS);
});
