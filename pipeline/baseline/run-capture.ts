/**
 * The baseline capture run: every confirmed kept page at every configured
 * viewport, captured twice and written under the storage key.
 *
 * {@link planCapture} does every check that needs no browser, in order,
 * and refuses with a {@link CaptureRefusedError} before a server or a
 * browser starts and before anything is written: `viewports` unset in the
 * project config; no kept page; any kept page without a confirmation in
 * `<baselineDir>/confirmed.json` whose `importHash` is the one this run
 * captures under, every such page named. No import record is the
 * `MissingImportRecordError` of `key.ts`, and no `discovery.json` the error
 * `keptPages` throws.
 *
 * {@link runCapture} then starts the server over the source dir, launches
 * Chromium, and double-captures each page (sorted by path) at each
 * viewport (in config order), reading the page's animation inventory in
 * the first capture's context at the first viewport. Every capture is held
 * in memory until all have finished, so a capture that throws leaves the
 * key directory as it was. Then, under
 * `<baselineDir>/<playwright version>/<import hash>/`, it writes each
 * `captured` PNG at `pages/<page path>/<viewport name>.png`, removes the PNG
 * of any page and viewport found `flaky` so no stale image stands in for
 * it, and writes `capture.json` ({@link captureFileSchema}) and
 * `animations.json`. Every path is resolved and checked against the key
 * directory before it is written. A flaky page does not stop the run; the
 * record carries its differing-pixel count and region, and
 * {@link flakyCaptures} lists them.
 *
 * @packageDocumentation
 */

import type { AnimationEntry, PageAnimations } from './animations.ts';
import type { DoubleCaptureResult } from './capture.ts';
import type { CaptureViewport } from './settings.ts';
import type { PagesConfig } from '../serve/nav.ts';
import type { Browser } from 'playwright';

import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { chromium } from 'playwright';
import { z } from 'zod';

import { keptPages } from '../serve/check.ts';
import { startServer } from '../serve/server.ts';

import { readAnimationInventory, writeAnimations } from './animations.ts';
import { doubleCapture, doubleCaptureInspecting } from './capture.ts';
import { readConfirmed, unconfirmedPages } from './confirmed.ts';
import {
  BaselinePathError,
  keyDirectory,
  pagePngPath,
  readImportHash,
  readPlaywrightVersion,
} from './key.ts';

/** The capture record's file name, directly under the key directory. */
export const CAPTURE_FILE = 'capture.json';

/** The command that records the confirmations capture needs. */
export const CONFIRM_COMMAND = 'bun run d2c baseline confirm';

/** Random bytes in the temporary file's name, so two writers never share one. */
const TEMP_NAME_BYTES = 6;

const nonEmptyString = z.string().min(1);

/** The box enclosing every differing pixel of a flaky capture, in image pixels. */
export const captureRegionSchema = z.strictObject({
  x: z.int().nonnegative(),
  y: z.int().nonnegative(),
  width: z.int().positive(),
  height: z.int().positive(),
});

/** One page at one viewport: `captured` with its PNG's path under the key directory, or `flaky`. */
export const viewportCaptureSchema = z.discriminatedUnion('status', [
  z.strictObject({ viewport: nonEmptyString, status: z.literal('captured'), file: nonEmptyString }),
  z.strictObject({
    viewport: nonEmptyString,
    status: z.literal('flaky'),
    differingPixels: z.int().positive(),
    region: captureRegionSchema,
  }),
]);

/** One page and what each viewport's double capture gave. */
export const pageCaptureSchema = z.strictObject({
  page: nonEmptyString,
  viewports: z.array(viewportCaptureSchema).min(1),
});

/** Validates `capture.json`. */
export const captureFileSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  playwrightVersion: nonEmptyString,
  importHash: z.string().regex(/^[0-9a-f]{64}$/, { error: 'must be 64 lowercase hex digits' }),
  pages: z.array(pageCaptureSchema),
});

/** A parsed capture record. */
export type CaptureRecord = z.infer<typeof captureFileSchema>;

/** Capture will not start; `pages` names the unconfirmed pages when that is why. */
export class CaptureRefusedError extends Error {
  override readonly name = 'CaptureRefusedError';

  /** The kept pages that lack a current confirmation; `[]` for any other refusal. */
  readonly pages: readonly string[];

  constructor(message: string, pages: readonly string[] = []) {
    super(message);
    this.pages = pages;
  }
}

/** What {@link planCapture} and {@link runCapture} read. */
export interface RunCaptureOptions {
  /** The project's `source.dir`, resolved. */
  readonly sourceDir: string;
  /** The config's `baselineDir`, relative to `rootDir` or absolute. */
  readonly baselineDir: string;
  /** The directory a relative `baselineDir` resolves against. */
  readonly rootDir: string;
  /** The config's `pages`; `pages.discard` leaves a page out. */
  readonly pages: PagesConfig;
  /** The config's `viewports`; capture refuses when unset or empty. */
  readonly viewports: readonly CaptureViewport[] | undefined;
  /** The environment the server reads `D2C_PORT` from; `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Launches the browser; headless Chromium by default. */
  readonly launchBrowser?: () => Promise<Browser>;
  /** The clock `generatedAt` is read from; the current time by default. */
  readonly now?: () => Date;
}

/** What a run captures and where, fixed before any browser starts. */
export interface CapturePlan {
  /** The key directory everything is written under. */
  readonly keyDir: string;
  /** The installed Playwright version. */
  readonly playwrightVersion: string;
  /** The SHA-256 hex of the import record. */
  readonly importHash: string;
  /** The kept pages, sorted by path, every one confirmed for `importHash`. */
  readonly pages: readonly string[];
  /** The viewports, in config order; never empty. */
  readonly viewports: readonly [CaptureViewport, ...CaptureViewport[]];
}

/** What {@link runCapture} wrote. */
export interface RunCaptureResult {
  /** The key directory written under. */
  readonly keyDir: string;
  /** `capture.json` as written. */
  readonly record: CaptureRecord;
}

/** One flaky page and viewport, as {@link flakyCaptures} lists it. */
export interface FlakyCapture {
  readonly page: string;
  readonly viewport: string;
  readonly differingPixels: number;
  readonly region: z.infer<typeof captureRegionSchema>;
}

/** One viewport's double capture of a page. */
interface ViewportRun {
  readonly viewport: CaptureViewport;
  readonly result: DoubleCaptureResult;
}

/** One page's captures, in viewport order, and its inventory. */
interface PageRun {
  readonly page: string;
  readonly captures: readonly ViewportRun[];
  readonly animations: readonly AnimationEntry[];
}

/**
 * Checks everything capture needs that no browser does and fixes the key.
 *
 * @throws CaptureRefusedError when `viewports` is unset or empty, when no
 * page is kept, or when any kept page lacks a confirmation for the current
 * import hash; the message and `pages` name every such page.
 * @throws MissingImportRecordError when the source dir has no import record.
 * @throws Error from `keptPages` when there is no valid `discovery.json`,
 * and `ConfirmedFileError` when `confirmed.json` is invalid.
 */
export function planCapture(options: RunCaptureOptions): CapturePlan {
  const { sourceDir, baselineDir, rootDir } = options;
  const [firstViewport, ...otherViewports] = options.viewports ?? [];

  if (firstViewport === undefined) {
    throw new CaptureRefusedError('`viewports` is not set in the project config; add at least one { name, width, height }');
  }

  const importHash = readImportHash(sourceDir);
  const pages = keptPages(sourceDir, options.pages);

  if (pages.length === 0) {
    throw new CaptureRefusedError(`no kept pages to capture in ${sourceDir}`);
  }

  const unconfirmed = unconfirmedPages(pages, readConfirmed(resolve(rootDir, baselineDir)), importHash);

  if (unconfirmed.length > 0) {
    throw new CaptureRefusedError(
      `${unconfirmed.length} of ${pages.length} kept pages have no confirmation for the current import: ${unconfirmed.join(', ')}; run \`${CONFIRM_COMMAND}\` first`,
      unconfirmed,
    );
  }

  const playwrightVersion = readPlaywrightVersion();

  return {
    keyDir: keyDirectory({ baselineDir, rootDir, playwrightVersion, importHash }),
    playwrightVersion,
    importHash,
    pages,
    viewports: [firstViewport, ...otherViewports],
  };
}

/**
 * `<keyDir>/capture.json`, resolved and checked to lie directly inside
 * `keyDir`.
 *
 * @throws BaselinePathError when the resolved path is not inside `keyDir`.
 */
export function capturePath(keyDir: string): string {
  const root = resolve(keyDir);
  const target = resolve(root, CAPTURE_FILE);
  const fromRoot = relative(root, target);

  if (isAbsolute(fromRoot) || fromRoot !== CAPTURE_FILE) {
    throw new BaselinePathError(`${CAPTURE_FILE} does not resolve inside ${root}`);
  }

  return target;
}

/** Every flaky page and viewport of `record`, in record order. */
export function flakyCaptures(record: CaptureRecord): readonly FlakyCapture[] {
  return record.pages.flatMap((entry) => entry.viewports.flatMap((capture) => (capture.status === 'flaky'
    ? [{ page: entry.page, viewport: capture.viewport, differingPixels: capture.differingPixels, region: capture.region }]
    : [])));
}

/** Double-captures one page at every viewport, the inventory read at the first. */
async function capturePageRun(browser: Browser, address: string, page: string, plan: CapturePlan): Promise<PageRun> {
  const [first, ...rest] = plan.viewports;
  const inspected = await doubleCaptureInspecting(
    browser,
    { address, path: page, viewport: first },
    readAnimationInventory,
  );
  const captures: ViewportRun[] = [{ viewport: first, result: inspected.result }];

  for (const viewport of rest) {
    captures.push({ viewport, result: await doubleCapture(browser, { address, path: page, viewport }) });
  }

  return { page, captures, animations: inspected.inspected };
}

/** Starts the server and the browser, captures every page, and stops both. */
async function captureAll(options: RunCaptureOptions, plan: CapturePlan): Promise<readonly PageRun[]> {
  const launch = options.launchBrowser ?? (() => chromium.launch());
  const server = await startServer({ sourceDir: options.sourceDir, env: options.env });

  try {
    const browser = await launch();

    try {
      const runs: PageRun[] = [];

      for (const page of plan.pages) {
        runs.push(await capturePageRun(browser, server.address, page, plan));
      }

      return runs;
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
}

/** `png` as a POSIX path relative to `keyDir`. */
function keyRelative(keyDir: string, png: string): string {
  return relative(keyDir, png).split(sep)
    .join('/');
}

/** The record entry for one viewport's result. */
function viewportEntry(keyDir: string, page: string, { viewport, result }: ViewportRun) {
  if (result.status === 'captured') {
    return { viewport: viewport.name, status: result.status, file: keyRelative(keyDir, pagePngPath(keyDir, page, viewport.name)) };
  }

  return { viewport: viewport.name, status: result.status, differingPixels: result.diff.differingPixels, region: result.diff.region };
}

/** Writes `text` to `target` through a temporary file beside it renamed over it. */
function writeAtomically(target: string, text: string): void {
  const tempPath = `${target}.${process.pid}.${randomBytes(TEMP_NAME_BYTES).toString('hex')}.tmp`;

  mkdirSync(dirname(target), { recursive: true });

  try {
    writeFileSync(tempPath, text);
    renameSync(tempPath, target);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/** Writes the PNGs, removes flaky pages' stale PNGs, and writes both records. */
function writeBaseline(plan: CapturePlan, runs: readonly PageRun[], generatedAt: Date): CaptureRecord {
  const { keyDir } = plan;
  const record = captureFileSchema.parse({
    generatedAt: generatedAt.toISOString(),
    playwrightVersion: plan.playwrightVersion,
    importHash: plan.importHash,
    pages: runs.map((run) => ({
      page: run.page,
      viewports: run.captures.map((capture) => viewportEntry(keyDir, run.page, capture)),
    })),
  });
  const inventories: PageAnimations[] = runs.map((run) => ({
    page: run.page,
    viewport: plan.viewports[0].name,
    animations: run.animations,
  }));
  const target = capturePath(keyDir);

  runs.forEach((run) => {
    run.captures.forEach(({ viewport, result }) => {
      const png = pagePngPath(keyDir, run.page, viewport.name);

      if (result.status === 'captured') {
        mkdirSync(dirname(png), { recursive: true });
        writeFileSync(png, result.png);
      } else {
        rmSync(png, { force: true });
      }
    });
  });
  writeAtomically(target, `${JSON.stringify(record, null, 2)}\n`);
  writeAnimations(keyDir, inventories);

  return record;
}

/**
 * Captures every confirmed kept page at every viewport and writes the
 * baseline under its key.
 *
 * @returns The key directory and `capture.json` as written; a flaky page
 * does not throw, {@link flakyCaptures} lists it.
 * @throws CaptureRefusedError, and the other errors of
 * {@link planCapture}, before any server or browser starts.
 * @throws Error when the server or the browser does not start, or a page
 * does not load or settle; nothing is written under the key then.
 */
export async function runCapture(options: RunCaptureOptions): Promise<RunCaptureResult> {
  const plan = planCapture(options);
  const runs = await captureAll(options, plan);
  const record = writeBaseline(plan, runs, (options.now ?? (() => new Date()))());

  return { keyDir: plan.keyDir, record };
}
