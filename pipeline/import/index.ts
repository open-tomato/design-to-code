/**
 * The import entry point: places a design export into a project's source
 * dir and writes the import record.
 *
 * {@link importSource} takes a folder or a `.zip` file. Every check that can
 * refuse the import runs before the source dir is touched: the kind of the
 * source, whether the source and the source dir overlap, whether the source
 * dir is non-empty without `force`, whether two paths of the export differ
 * only in case, and, for a zip, the whole extraction (done into a temporary
 * directory first). Only then is the source dir created or emptied, the
 * files copied in, and `.import/record.json` written.
 *
 * Every failure is an {@link ImportError} whose message a CLI can print as
 * it stands.
 *
 * @packageDocumentation
 */

import type { DroppedEntry, ImportKind, ImportRecord } from './record.ts';
import type { Dirent } from 'node:fs';

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { describeCaseCollisions, findCaseCollisions } from './case-fold.ts';
import { RECORD_DIR, writeImportRecord } from './record.ts';
import { extractZip, ZipError } from './zip.ts';

/** An import that cannot go ahead; the message says why, ready to print. */
export class ImportError extends Error {
  override readonly name = 'ImportError';
}

/** What {@link importSource} imports, and where to. */
export interface ImportOptions {
  /** A directory (kind `folder`) or a path ending in `.zip` (kind `zip`). */
  readonly source: string;
  /** The project's `source.dir`; created when missing. */
  readonly sourceDir: string;
  /** Empty a non-empty `sourceDir` first instead of refusing. */
  readonly force: boolean;
  /** The import time for the record; the current time by default. */
  readonly now?: Date;
  /**
   * The existing directory a zip is extracted under before anything is
   * copied: a fresh `d2c-import-*` folder is made in it and removed again
   * whether the import succeeds or is refused. `tmpdir()` by default.
   */
  readonly stagingRoot?: string;
}

/** The suffix, compared case-insensitively, that marks a zip source. */
const ZIP_SUFFIX = '.zip';

/** The import kinds {@link importSource} produces. */
type LocalImportKind = Extract<ImportKind, 'folder' | 'zip'>;

/** One file of a source tree, POSIX-relative to its root. */
interface SourceFile {
  readonly segments: readonly string[];
}

/**
 * Tells a folder source from a zip source; anything else, a missing path
 * included, is an {@link ImportError}. A directory is a folder even when
 * its name ends in `.zip`.
 */
export function detectSourceKind(source: string): LocalImportKind {
  const stats = statSync(source, { throwIfNoEntry: false });

  if (stats === undefined) {
    throw new ImportError(`${source}: no such file or directory`);
  }

  if (stats.isDirectory()) {
    return 'folder';
  }

  if (stats.isFile() && source.toLowerCase().endsWith(ZIP_SUFFIX)) {
    return 'zip';
  }

  throw new ImportError(`${source}: not a folder or a ${ZIP_SUFFIX} file; cannot import it`);
}

function isInside(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);

  return fromParent === '' || (!fromParent.startsWith('..') && !isAbsolute(fromParent));
}

/** Refuses a folder source and a source dir that contain one another. */
function assertNoOverlap(source: string, sourceDir: string): void {
  const from = resolve(source);
  const to = resolve(sourceDir);

  if (isInside(from, to) || isInside(to, from)) {
    throw new ImportError(`${source} and ${sourceDir} overlap; import from a folder outside the source dir`);
  }
}

/**
 * Checks the source dir can take the import: absent (it will be created),
 * or a directory that is empty or may be emptied. Returns whether it exists.
 */
function checkTarget(sourceDir: string, force: boolean): boolean {
  const stats = statSync(sourceDir, { throwIfNoEntry: false });

  if (stats === undefined) {
    return false;
  }

  if (!stats.isDirectory()) {
    throw new ImportError(`${sourceDir}: exists and is not a directory`);
  }

  if (!force && readdirSync(sourceDir).length > 0) {
    throw new ImportError(`${sourceDir}: not empty; refusing to import over it (pass --force to empty it first)`);
  }

  return true;
}

function describeEntry(entry: Dirent): string {
  return entry.isSymbolicLink()
    ? 'a symlink'
    : 'not a regular file or directory';
}

/**
 * Lists every regular file under `root`, skipping a top-level `.import/`.
 * Any other entry, such as a symlink, is an {@link ImportError}, so nothing
 * outside the source folder is ever read.
 */
function listSourceFiles(root: string, prefix: readonly string[] = []): readonly SourceFile[] {
  const entries = readdirSync(join(root, ...prefix), { withFileTypes: true });

  return entries.flatMap((entry) => {
    const segments = [...prefix, entry.name];

    if (prefix.length === 0 && entry.name === RECORD_DIR) {
      return [];
    }

    if (entry.isDirectory()) {
      return listSourceFiles(root, segments);
    }

    if (entry.isFile()) {
      return [{ segments }];
    }

    throw new ImportError(`${join(root, ...segments)}: ${describeEntry(entry)}; cannot import it`);
  });
}

/**
 * Refuses a folder whose files, or folders, differ only in case, which a
 * case-insensitive file system cannot hold side by side.
 */
function assertNoCaseCollisions(source: string, files: readonly SourceFile[]): void {
  const collisions = findCaseCollisions(files.map((file) => file.segments.join('/')));

  if (collisions.length > 0) {
    throw new ImportError(describeCaseCollisions(source, collisions));
  }
}

/** Joins segments under `root` and proves the result stays inside it. */
function placeInside(root: string, segments: readonly string[]): string {
  const target = resolve(root, ...segments);

  if (target === root || !isInside(root, target)) {
    throw new ImportError(`${target} does not resolve inside ${root}`);
  }

  return target;
}

/** Removes everything inside `dir`, keeping `dir` itself. */
function emptyDirectory(dir: string): void {
  const root = resolve(dir);

  for (const name of readdirSync(root)) {
    rmSync(placeInside(root, [name]), { recursive: true, force: true });
  }
}

function copyFiles(fromRoot: string, files: readonly SourceFile[], toDir: string): void {
  const from = resolve(fromRoot);
  const to = resolve(toDir);

  for (const { segments } of files) {
    const target = placeInside(to, segments);

    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(placeInside(from, segments), target);
  }
}

/** A zip extracted into a staging folder, and the entries it left out. */
interface StagedZip {
  readonly stagingDir: string;
  readonly dropped: readonly DroppedEntry[];
}

/**
 * Extracts a zip into a fresh temporary directory under `stagingRoot`,
 * wrapping its errors.
 */
function stageZip(zipPath: string, stagingRoot: string): StagedZip {
  const stagingDir = mkdtempSync(join(stagingRoot, 'd2c-import-'));

  try {
    const { dropped } = extractZip(zipPath, join(stagingDir, 'files'));

    return { stagingDir, dropped };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });

    if (error instanceof ZipError) {
      throw new ImportError(error.message, { cause: error });
    }

    throw error;
  }
}

/**
 * Places the files of a folder or zip into `sourceDir` and writes
 * `<sourceDir>/.import/record.json`.
 *
 * - A directory `source` is kind `folder` and is copied recursively; a
 *   symlink or other special entry refuses the import. The source and
 *   `sourceDir` must not overlap.
 * - A file `source` ending in `.zip` (any case) is kind `zip` and is
 *   extracted by `extractZip`, macOS Finder metadata dropped and lone
 *   top-level folder unwrapped, into a temporary folder under `stagingRoot`
 *   (`tmpdir()` by default) that is removed before this returns or throws.
 *   The dropped entries go into the record's `dropped`; a folder import
 *   records `dropped: []`.
 * - A top-level `.import/` in either is skipped; the record is rewritten.
 * - Two paths, or two folder prefixes, that differ only in case refuse the
 *   import, naming both spellings: a folder's files are checked here, a
 *   zip's entries by `extractZip`.
 * - A source with no files, or any other source, is refused.
 * - A missing `sourceDir` is created. A non-empty one is refused unless
 *   `force` is set, in which case its contents are removed first.
 *
 * Every refusal happens before `sourceDir` is created or changed.
 *
 * @returns The import record as written.
 * @throws ImportError when the import cannot go ahead.
 */
export function importSource(options: ImportOptions): ImportRecord {
  const { source, sourceDir, force, now, stagingRoot = tmpdir() } = options;
  const kind = detectSourceKind(source);

  if (kind === 'folder') {
    assertNoOverlap(source, sourceDir);
  }

  const targetExists = checkTarget(sourceDir, force);
  const staged = kind === 'zip'
    ? stageZip(source, stagingRoot)
    : undefined;
  const stagingDir = staged?.stagingDir;

  try {
    const filesRoot = stagingDir === undefined
      ? source
      : join(stagingDir, 'files');
    const files = listSourceFiles(filesRoot);

    if (files.length === 0) {
      throw new ImportError(`${source}: holds no files; nothing to import`);
    }

    if (kind === 'folder') {
      assertNoCaseCollisions(source, files);
    }

    if (targetExists) {
      emptyDirectory(sourceDir);
    } else {
      mkdirSync(sourceDir, { recursive: true });
    }

    copyFiles(filesRoot, files, sourceDir);

    return writeImportRecord({ sourceDir, kind, originalPath: source, now, dropped: staged?.dropped });
  } finally {
    if (stagingDir !== undefined) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}
