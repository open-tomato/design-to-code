/**
 * The project-config writer: records a page's curation choice in
 * `projects/<slug>.json`.
 *
 * Every write re-reads the file, changes only `pages` in the raw JSON as
 * written — so no default the schema fills in is ever baked into the file —
 * validates the result with {@link projectConfigSchema}, and only then
 * replaces the file through a temporary file in the same directory and a
 * rename. A failed validation is a {@link ProjectConfigError} and leaves the
 * file as it was.
 *
 * @packageDocumentation
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { PROJECTS_DIR, ProjectConfigError, REPO_ROOT } from './load.ts';
import { projectConfigSchema, SLUG_PATTERN } from './schema.ts';

/** The curation choices a page can be given. */
export const PAGE_CHOICES = ['keep', 'discard'] as const;

/** A page's curation choice: listed in `pages.keep` or `pages.discard`. */
export type PageChoice = (typeof PAGE_CHOICES)[number];

/** The page lists as they stand after a write; an absent list is empty. */
export interface PageChoices {
  /** The pages in `pages.keep`, sorted. */
  readonly keep: readonly string[];
  /** The pages in `pages.discard`, sorted. */
  readonly discard: readonly string[];
}

/** Where {@link savePageChoice} writes; each field has a default. */
export interface SaveOptions {
  /** The directory `projects/` sits in; {@link REPO_ROOT} by default. */
  readonly rootDir?: string;
}

type JsonObject = Record<string, unknown>;

/** Spaces per indent level of the written JSON. */
const JSON_INDENT = 2;

/** Random bytes in the temporary file's name. */
const TEMP_NAME_BYTES = 6;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRawConfig(filePath: string, displayPath: string): JsonObject {
  let text: string;

  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new ProjectConfigError(`${displayPath}: project file not found`);
    }

    throw error;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProjectConfigError(`${displayPath}: not valid JSON: ${(error as Error).message}`);
  }

  if (!isJsonObject(raw)) {
    throw new ProjectConfigError(`${displayPath}: invalid project config\n  (root): expected an object`);
  }

  return raw;
}

function sortedUnique(list: readonly string[]): string[] {
  return [...new Set(list)].sort();
}

/**
 * Returns `list` without `page`; a value that is not a list is returned
 * as written, for the schema to reject.
 */
function without(list: unknown, page: string): unknown {
  return Array.isArray(list)
    ? sortedUnique(list.filter((entry) => entry !== page))
    : list;
}

function withPage(list: unknown, page: string): unknown {
  if (list === undefined) {
    return [page];
  }

  return Array.isArray(list)
    ? sortedUnique([...list, page])
    : list;
}

function movePage(pages: JsonObject, page: string, choice: PageChoice): JsonObject {
  const other: PageChoice = choice === 'keep'
    ? 'discard'
    : 'keep';
  const moved: JsonObject = { ...pages, [choice]: withPage(pages[choice], page) };

  return pages[other] === undefined
    ? moved
    : { ...moved, [other]: without(pages[other], page) };
}

function validate(raw: JsonObject, displayPath: string): PageChoices {
  const result = projectConfigSchema.safeParse(raw);

  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );

    throw new ProjectConfigError(`${displayPath}: invalid project config\n${lines.join('\n')}`);
  }

  return {
    keep: result.data.pages?.keep ?? [],
    discard: result.data.pages?.discard ?? [],
  };
}

function writeAtomically(filePath: string, text: string): void {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(TEMP_NAME_BYTES).toString('hex')}.tmp`;

  try {
    writeFileSync(tempPath, text);
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/**
 * Moves `page` into `pages.keep` or `pages.discard` of `projects/<slug>.json`
 * and out of the other list.
 *
 * Steps, each of which throws a {@link ProjectConfigError} on failure:
 * 1. check that `slug` is a slug, so it cannot name a path outside
 *    `projects/`;
 * 2. read the file fresh and parse it as a JSON object;
 * 3. add `page` to the chosen list and remove it from the other, both
 *    sorted and without duplicates; an absent other list stays absent, and
 *    every other field — including other keys of `pages` — stays as written;
 * 4. validate the changed config with {@link projectConfigSchema}; on
 *    failure nothing is written and the message lists every failing field;
 * 5. write it as 2-space JSON with a trailing newline to a temporary file
 *    beside it, then rename that over the config.
 *
 * Reading or writing fails with the error the file system threw for
 * anything other than a missing config file. The page name is not checked
 * against `discovery.json`; the caller does that.
 *
 * @param slug - The project whose config to change.
 * @param page - The page path, as `discovery.json` lists it.
 * @param choice - The list to move the page into.
 * @param options - The root `projects/` is read from.
 * @returns Both lists as written, each sorted.
 */
export function savePageChoice(
  slug: string,
  page: string,
  choice: PageChoice,
  options: SaveOptions = {},
): PageChoices {
  const { rootDir = REPO_ROOT } = options;

  if (!SLUG_PATTERN.test(slug)) {
    throw new ProjectConfigError(
      `'${slug}' is not a slug; use lowercase letters and digits in hyphen-separated runs`,
    );
  }

  const filePath = join(rootDir, PROJECTS_DIR, `${slug}.json`);
  const displayPath = relative(rootDir, filePath);
  const raw = readRawConfig(filePath, displayPath);
  const pages = raw.pages === undefined
    ? {}
    : raw.pages;

  if (!isJsonObject(pages)) {
    throw new ProjectConfigError(`${displayPath}: invalid project config\n  pages: expected an object`);
  }

  const next = { ...raw, pages: movePage(pages, page, choice) };
  const choices = validate(next, displayPath);

  writeAtomically(filePath, `${JSON.stringify(next, null, JSON_INDENT)}\n`);

  return choices;
}
