/**
 * Baseline confirmation: records, for every kept page, that the served demo
 * works as it did in Claude Design, in `<baselineDir>/confirmed.json` under
 * the current import hash.
 *
 * {@link runConfirm} reads the import hash, the kept pages (none is a
 * {@link ConfirmRefusedError}) and the existing `confirmed.json` before a
 * server starts, then serves the source dir with `startServer` and
 * confirms every kept page, sorted by path, in two passes.
 *
 * The share-link pass runs when `source.shareLink` is set. It opens a
 * {@link ShareLinkComparer} (headless Chromium over `share-link.ts` by
 * default) and asks whether the link is public; when it is, each page is
 * scored at the first configured viewport, or at
 * {@link DEFAULT_CONFIRM_VIEWPORT} when `viewports` is unset. A page that
 * scores under `CONFIRM_THRESHOLD` is recorded `by: 'share-link'` with its
 * score. A higher score, a view with no design frame, an unreachable view,
 * or a comparison that throws sends the page to the person, the reason
 * printed; a link that is not public sends every page.
 *
 * The person pass runs the `serve --check` page checker once over the
 * running server, then for each page left prints the page path and its
 * findings (console errors, failed requests and the blank flag), opens the
 * page with the nav bar off through the injected {@link PageOpener}, and
 * asks {@link confirmQuestion} through the injected {@link Prompter}. An
 * answer of `y` or `Y`, surrounding whitespace ignored, records
 * `by: 'person'`; any other answer, an empty one included, leaves the page
 * unconfirmed and removes any entry it had. The opened page is closed
 * whatever the answer.
 *
 * Each decision is written to `confirmed.json` as soon as it is made, so a
 * run stopped part-way keeps the pages already decided; entries for other
 * pages are left as they are. Output goes only through the injected `print`.
 *
 * @packageDocumentation
 */

import type { ConfirmedEntry } from './confirmed.ts';
import type { CaptureViewport } from './settings.ts';
import type { PageScore, ShareLinkAccess, ShareScoreTarget } from './share-link.ts';
import type { CheckPagesOptions, FailedRequest, PageCheck, ServeCheckReport } from '../serve/check.ts';
import type { PagesConfig } from '../serve/nav.ts';

import { resolve } from 'node:path';

import { chromium } from 'playwright';

import { checkPages as checkServedPages, checkUrl, keptPages } from '../serve/check.ts';
import { startServer } from '../serve/server.ts';

import { readConfirmed, recordConfirmation, writeConfirmed } from './confirmed.ts';
import { readImportHash } from './key.ts';
import { CONFIRM_THRESHOLD, checkShareLink, scoreSharedPage } from './share-link.ts';

/** The viewport the share link is scored at when the config sets no `viewports`. */
export const DEFAULT_CONFIRM_VIEWPORT: CaptureViewport = { name: 'desktop', width: 1280, height: 800 };

/** The answer, compared case-insensitively after trimming, that confirms a page. */
export const CONFIRM_ANSWER = 'y';

/** A score's digits after the point when printed as a percentage. */
const PERCENT_DIGITS = 2;

/** A page the {@link PageOpener} opened for the person to look at. */
export interface OpenedPage {
  /** Closes the page's window; called once the person has answered. */
  close(): Promise<void>;
}

/** Opens `url`, the served page `page` with the nav bar off, for the person. */
export type PageOpener = (target: { readonly page: string; readonly url: string }) => Promise<OpenedPage>;

/** Asks the person `question` and resolves their answer as typed. */
export type Prompter = (question: string) => Promise<string>;

/** The share-link comparison, over one browser that {@link ShareLinkComparer.close} releases. */
export interface ShareLinkComparer {
  /** Whether the share link is public, as `checkShareLink`. */
  check(shareLink: string): Promise<ShareLinkAccess>;
  /** One page's score against its design view, as `scoreSharedPage`. */
  score(target: ShareScoreTarget): Promise<PageScore>;
  /** Releases the browser. */
  close(): Promise<void>;
}

/** What {@link runConfirm} reads. */
export interface ConfirmOptions {
  /** The project's `source.dir`, resolved. */
  readonly sourceDir: string;
  /** The config's `baselineDir`, relative to `rootDir` or absolute. */
  readonly baselineDir: string;
  /** The directory a relative `baselineDir` resolves against. */
  readonly rootDir: string;
  /** The config's `pages`; `pages.discard` leaves a page out. */
  readonly pages: PagesConfig;
  /** The config's `viewports`; the first is the one the share link is scored at. */
  readonly viewports: readonly CaptureViewport[] | undefined;
  /** The config's `source.shareLink`; unset skips the share-link pass. */
  readonly shareLink: string | undefined;
  /** Opens a page for the person. */
  readonly openPage: PageOpener;
  /** Asks the person whether a page works. */
  readonly prompt: Prompter;
  /** Shows the person a block of text; each call ends with a newline. */
  readonly print: (text: string) => void;
  /** The `serve --check` page checker; `checkPages` of `serve/check.ts` by default. */
  readonly checkPages?: (options: CheckPagesOptions) => Promise<ServeCheckReport>;
  /** Opens the share-link comparison; headless Chromium by default. */
  readonly openComparer?: () => Promise<ShareLinkComparer>;
  /** The environment the server reads `D2C_PORT` from; `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The clock `confirmedAt` is read from; the current time by default. */
  readonly now?: () => Date;
}

/** One kept page's outcome. */
export type PageConfirmation =
  | { readonly page: string; readonly status: 'confirmed'; readonly entry: ConfirmedEntry }
  | { readonly page: string; readonly status: 'unconfirmed' };

/** What {@link runConfirm} decided and wrote. */
export interface ConfirmResult {
  /** The import hash every confirmation was recorded under. */
  readonly importHash: string;
  /** Every kept page's outcome, sorted by path. */
  readonly pages: readonly PageConfirmation[];
  /** `confirmed.json` as last written. */
  readonly entries: readonly ConfirmedEntry[];
}

/** Confirm will not start. */
export class ConfirmRefusedError extends Error {
  override readonly name = 'ConfirmRefusedError';
}

/** Where the run writes, the import hash it records under, and its clock. */
type Ledger = Readonly<{ baselineRoot: string; importHash: string; now: () => Date }>;

/** The question the person answers for `page`. */
export function confirmQuestion(page: string): string {
  return `Does ${page} work as in Claude Design? [y/N] `;
}

/** Whether `answer` confirms the page. */
export function isConfirming(answer: string): boolean {
  return answer.trim().toLowerCase() === CONFIRM_ANSWER;
}

/** `score` as a percentage with {@link PERCENT_DIGITS} decimals. */
function percent(score: number): string {
  return `${(score * 100).toFixed(PERCENT_DIGITS)}%`;
}

/** The error's message, or its string form when it is not an `Error`. */
function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

/** One failed request as one line. */
function requestLine(request: FailedRequest): string {
  return 'reason' in request
    ? `${request.url} (${request.reason})`
    : `${request.url} (status ${request.status})`;
}

/** A labelled list: `none` on the label's line, or a count and one item per line. */
function listLines(label: string, items: readonly string[]): readonly string[] {
  return items.length === 0
    ? [`  ${label}: none`]
    : [`  ${label} (${items.length}):`, ...items.map((item) => `    - ${item}`)];
}

/**
 * The text printed before the person is asked about `page`: its path, then
 * its console errors, failed requests and blank flag from `serve --check`.
 *
 * @param page - The page path.
 * @param check - The page's reading, or `undefined` when the report has none.
 */
export function findingsText(page: string, check: PageCheck | undefined): string {
  if (check === undefined) {
    return `${page}\n  serve --check: no reading for this page`;
  }

  return [
    page,
    ...listLines('console errors', check.consoleErrors),
    ...listLines('failed requests', check.failedRequests.map(requestLine)),
    `  blank: ${check.blank
      ? 'yes'
      : 'no'}`,
  ].join('\n');
}

/** Records `entry` for `page`, or removes the page's entry when `entry` is `null`. */
function record({ baselineRoot }: Ledger, page: string, entry: ConfirmedEntry | null): void {
  if (entry === null) {
    writeConfirmed(baselineRoot, readConfirmed(baselineRoot).filter((existing) => existing.page !== page));
  } else {
    recordConfirmation(baselineRoot, entry);
  }
}

/** Why a page's share-link result does not confirm it, or `null` when it does. */
function fallbackReason(result: PageScore): string | null {
  if (result.status === 'frame-not-found') {
    return `no design frame in ${result.view}`;
  }

  if (result.status === 'view-unreachable') {
    return `design view ${result.view} unreachable (${result.reason}: ${result.detail})`;
  }

  return result.passed
    ? null
    : `share-link score ${percent(result.score)} is not under ${percent(CONFIRM_THRESHOLD)}`;
}

/** Scores one page, printing the outcome; resolves the entry, or `null` when the person must decide. */
async function scorePage(
  comparer: ShareLinkComparer,
  target: ShareScoreTarget,
  ledger: Ledger,
  print: (text: string) => void,
): Promise<ConfirmedEntry | null> {
  let result: PageScore;

  try {
    result = await comparer.score(target);
  } catch (error) {
    print(`${target.path}: share-link comparison failed (${messageOf(error)}); asking a person`);

    return null;
  }

  const reason = fallbackReason(result);

  if (reason !== null || result.status !== 'scored') {
    print(`${target.path}: ${reason}; asking a person`);

    return null;
  }

  print(`${target.path}: confirmed by share link, score ${percent(result.score)}`);

  return {
    page: target.path,
    confirmedAt: ledger.now().toISOString(),
    by: 'share-link',
    importHash: ledger.importHash,
    score: result.score,
  };
}

/** The share-link pass: confirms what it can and resolves the pages left for the person. */
async function confirmByShareLink(
  options: ConfirmOptions,
  address: string,
  pages: readonly string[],
  ledger: Ledger,
): Promise<readonly string[]> {
  const { shareLink, print } = options;

  if (shareLink === undefined) {
    print('No source.shareLink is set; asking a person about every page.');

    return pages;
  }

  const comparer = await (options.openComparer ?? launchComparer)();

  try {
    const access = await comparer.check(shareLink);

    if (access.status === 'not-public') {
      print(`Share link ${shareLink} is not public (${access.reason}: ${access.detail}); asking a person about every page.`);

      return pages;
    }

    const viewport = options.viewports?.[0] ?? DEFAULT_CONFIRM_VIEWPORT;
    const left: string[] = [];

    for (const path of pages) {
      const entry = await scorePage(comparer, { shareLink, address, path, viewport }, ledger, print);

      if (entry === null) {
        left.push(path);
      } else {
        record(ledger, path, entry);
      }
    }

    return left;
  } finally {
    await comparer.close();
  }
}

/** The person pass: prints each page's findings, opens it and asks. */
async function confirmByPerson(
  options: ConfirmOptions,
  address: string,
  pages: readonly string[],
  ledger: Ledger,
): Promise<void> {
  if (pages.length === 0) {
    return;
  }

  const check = options.checkPages ?? checkServedPages;
  const report = await check({ sourceDir: options.sourceDir, address, pages: options.pages, now: ledger.now });
  const readings = new Map(report.pages.map((reading) => [reading.path, reading]));

  for (const page of pages) {
    options.print(findingsText(page, readings.get(page)));

    const opened = await options.openPage({ page, url: checkUrl(address, page) });
    let answer: string;

    try {
      answer = await options.prompt(confirmQuestion(page));
    } finally {
      await opened.close();
    }

    record(ledger, page, isConfirming(answer)
      ? { page, confirmedAt: ledger.now().toISOString(), by: 'person', importHash: ledger.importHash }
      : null);
  }
}

/** The default comparer: `share-link.ts` over one headless Chromium browser. */
async function launchComparer(): Promise<ShareLinkComparer> {
  const browser = await chromium.launch();

  return {
    check: (shareLink) => checkShareLink(browser, shareLink),
    score: (target) => scoreSharedPage(browser, target),
    close: () => browser.close(),
  };
}

/** Each page's outcome, read back from the entries as written. */
function outcomes(pages: readonly string[], entries: readonly ConfirmedEntry[], importHash: string): readonly PageConfirmation[] {
  return pages.map((page) => {
    const entry = entries.find((candidate) => candidate.page === page && candidate.importHash === importHash);

    return entry === undefined
      ? { page, status: 'unconfirmed' }
      : { page, status: 'confirmed', entry };
  });
}

/**
 * Confirms every kept page, by the share link when it is public and the
 * page scores under the threshold, and by the person otherwise, writing
 * each decision to `<baselineDir>/confirmed.json` under the import hash.
 *
 * @returns The import hash, every kept page's outcome and the entries as
 * last written.
 * @throws ConfirmRefusedError when no page is kept, before a server starts.
 * @throws MissingImportRecordError when the source dir has no import
 * record, the error `keptPages` throws when there is no valid
 * `discovery.json`, and `ConfirmedFileError` when `confirmed.json` is
 * invalid; all before a server starts.
 * @throws Error when the server, the page checker, the opener or the
 * prompter fails; decisions already made stay written.
 */
export async function runConfirm(options: ConfirmOptions): Promise<ConfirmResult> {
  const { sourceDir } = options;
  const importHash = readImportHash(sourceDir);
  const pages = keptPages(sourceDir, options.pages);

  if (pages.length === 0) {
    throw new ConfirmRefusedError(`no kept pages to confirm in ${sourceDir}`);
  }

  const baselineRoot = resolve(options.rootDir, options.baselineDir);
  const ledger: Ledger = { baselineRoot, importHash, now: options.now ?? (() => new Date()) };

  readConfirmed(baselineRoot); // an invalid record refuses here, before the server starts

  const server = await startServer({ sourceDir, env: options.env });

  try {
    const left = await confirmByShareLink(options, server.address, pages, ledger);
    await confirmByPerson(options, server.address, left, ledger);

    const entries = readConfirmed(baselineRoot);

    return { importHash, pages: outcomes(pages, entries, importHash), entries };
  } finally {
    await server.stop();
  }
}
