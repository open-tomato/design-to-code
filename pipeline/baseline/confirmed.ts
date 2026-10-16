/**
 * The confirmation record: `<baselineDir>/confirmed.json`, which says which
 * pages a person or the share-link comparison confirmed work as in Claude
 * Design, and for which import.
 *
 * The file is a JSON array validated by {@link confirmedFileSchema}, one
 * entry per page, written sorted by page. An entry counts only for the
 * import whose hash it carries, so a re-import needs a new confirmation;
 * {@link unconfirmedPages} applies that rule. A missing file reads as no
 * confirmations; a file that is not valid JSON or fails the schema is a
 * {@link ConfirmedFileError} naming its path. {@link writeConfirmed}
 * writes to a temporary file beside the record and renames it over it, so
 * a reader never sees half a file.
 *
 * @packageDocumentation
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

/** The record's file name, at the top of the baseline dir. */
export const CONFIRMED_FILE = 'confirmed.json';

/** Who confirmed a page: a person at the prompt, or the share-link comparison. */
export const CONFIRMED_BY = ['person', 'share-link'] as const;

/** A SHA-256 digest as lowercase hex, as `readImportHash` returns it. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Random bytes in the temporary file's name, so two writers never share one. */
const TEMP_NAME_BYTES = 6;

const pageField = z.string().min(1);

const confirmedAtField = z.iso.datetime();

const importHashField = z.string().regex(SHA256_PATTERN, { error: 'must be 64 lowercase hex digits' });

/**
 * One page's confirmation, fields in the order they are written: `page`,
 * `confirmedAt`, `by`, `importHash`, then `score`. `score`, the share of
 * differing pixels between the design frame and the served page, is allowed
 * only on a `share-link` entry, where it is optional; a `person` entry
 * carries none.
 */
export const confirmedEntrySchema = z.discriminatedUnion('by', [
  z.strictObject({
    page: pageField,
    confirmedAt: confirmedAtField,
    by: z.literal('person'),
    importHash: importHashField,
  }),
  z.strictObject({
    page: pageField,
    confirmedAt: confirmedAtField,
    by: z.literal('share-link'),
    importHash: importHashField,
    score: z.number().min(0)
      .max(1)
      .optional(),
  }),
]);

/** Validates `confirmed.json`: an array of entries, no page listed twice. */
export const confirmedFileSchema = z.array(confirmedEntrySchema).superRefine((entries, context) => {
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    if (seen.has(entry.page)) {
      context.addIssue({ code: 'custom', path: [index, 'page'], message: `page "${entry.page}" is listed twice` });
    }

    seen.add(entry.page);
  });
});

/** A parsed confirmation entry. */
export type ConfirmedEntry = z.infer<typeof confirmedEntrySchema>;

/** `confirmed.json` could not be parsed or failed its schema. */
export class ConfirmedFileError extends Error {
  override readonly name = 'ConfirmedFileError';
}

/** `<baselineDir>/confirmed.json`, `baselineDir` already resolved. */
export function confirmedPath(baselineDir: string): string {
  return join(baselineDir, CONFIRMED_FILE);
}

/** Orders entries by page, code unit by code unit, independent of locale. */
function byPage(left: ConfirmedEntry, right: ConfirmedEntry): number {
  if (left.page === right.page) {
    return 0;
  }

  return left.page < right.page
    ? -1
    : 1;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Validates `raw` as the record, naming `target` and every failing field. */
function parseEntries(raw: unknown, target: string): readonly ConfirmedEntry[] {
  const result = confirmedFileSchema.safeParse(raw);

  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );

    throw new ConfirmedFileError(`${target}: invalid confirmation record\n${lines.join('\n')}`);
  }

  return result.data;
}

/**
 * Reads `<baselineDir>/confirmed.json`.
 *
 * @param baselineDir - The resolved baseline dir.
 * @returns The entries as written; `[]` when the file does not exist.
 * @throws ConfirmedFileError when the file is not JSON or fails
 * {@link confirmedFileSchema}; the message names the file's path. Any other
 * read failure is rethrown.
 */
export function readConfirmed(baselineDir: string): readonly ConfirmedEntry[] {
  const target = confirmedPath(baselineDir);
  let text: string;

  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfirmedFileError(`${target}: not valid JSON: ${(error as Error).message}`, { cause: error });
  }

  return parseEntries(raw, target);
}

/**
 * Writes `entries` to `<baselineDir>/confirmed.json`, sorted by page, as
 * 2-space JSON with a trailing newline, through a temporary file beside it
 * renamed over the record. Creates the baseline dir when it is missing.
 *
 * @param baselineDir - The resolved baseline dir.
 * @returns The entries as written.
 * @throws ConfirmedFileError when the entries fail
 * {@link confirmedFileSchema}, a page listed twice included; nothing is
 * written then.
 */
export function writeConfirmed(
  baselineDir: string,
  entries: readonly ConfirmedEntry[],
): readonly ConfirmedEntry[] {
  const target = confirmedPath(baselineDir);
  const sorted = [...parseEntries(entries, target)].sort(byPage);
  const tempPath = `${target}.${process.pid}.${randomBytes(TEMP_NAME_BYTES).toString('hex')}.tmp`;

  mkdirSync(baselineDir, { recursive: true });

  try {
    writeFileSync(tempPath, `${JSON.stringify(sorted, null, 2)}\n`);
    renameSync(tempPath, target);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }

  return sorted;
}

/**
 * Records `entry` in `<baselineDir>/confirmed.json`, replacing any earlier
 * entry for the same page, whatever import it was under.
 *
 * @returns The entries as written, sorted by page.
 * @throws ConfirmedFileError when the existing file or the new entry is
 * invalid; nothing is written then.
 */
export function recordConfirmation(baselineDir: string, entry: ConfirmedEntry): readonly ConfirmedEntry[] {
  const others = readConfirmed(baselineDir).filter((existing) => existing.page !== entry.page);

  return writeConfirmed(baselineDir, [...others, entry]);
}

/**
 * The kept pages with no confirmation under `importHash`: a page with no
 * entry, or whose entry was recorded for another import.
 *
 * @returns The pages, in the order `keptPages` lists them.
 */
export function unconfirmedPages(
  keptPages: readonly string[],
  confirmed: readonly ConfirmedEntry[],
  importHash: string,
): readonly string[] {
  const current = new Set(
    confirmed
      .filter((entry) => entry.importHash === importHash)
      .map((entry) => entry.page),
  );

  return keptPages.filter((page) => !current.has(page));
}
