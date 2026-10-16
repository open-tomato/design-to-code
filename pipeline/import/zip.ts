/**
 * Zip extraction for import: reads an archive with `fflate`, proves every
 * entry lands inside the target directory, and only then writes.
 *
 * The whole archive is checked before the first write. One entry that would
 * resolve outside the target — a `../` segment, an absolute path, a drive
 * letter, a backslash-separated escape such as `a\..\..\x`, or a NUL byte —
 * refuses the whole archive, and nothing is written. Backslashes count as
 * separators, as Windows zip tools write them.
 *
 * macOS Finder's "Compress" adds entries no export holds: AppleDouble files
 * under a top-level `__MACOSX/` folder, and `.DS_Store` files beside the
 * real ones. Both are dropped, and reported, before the unwrap below, so a
 * Finder zip of one folder unwraps like any other. A `__MACOSX/` folder
 * below the top level is an ordinary folder and is kept.
 *
 * An archive whose every entry sits under one top-level folder is unwrapped,
 * so a zip of `site/index.html` and a zip of `index.html` both land as
 * `index.html`. Only that one level is removed.
 *
 * After the drops and the unwrap, two paths, or two folder prefixes, that
 * differ only in case (`a.html` beside `A.html`, `Pages/a.html` beside
 * `pages/b.html`) refuse the whole archive, as a case-insensitive file
 * system could hold only one of them; see `case-fold.ts`.
 *
 * `fflate` exposes no entry attributes, so a symlink entry arrives as a
 * regular file holding its link text; nothing but regular files and
 * directories is ever created.
 *
 * @packageDocumentation
 */

import type { DroppedEntry } from './record.ts';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { unzipSync } from 'fflate';

import { describeCaseCollisions, findCaseCollisions } from './case-fold.ts';
import { byPath } from './record.ts';

/**
 * A zip that cannot be extracted: unreadable, empty, holding an entry that
 * leaves the target, holding two entries that claim the same path, or
 * holding two paths that differ only in case. Its
 * message names the archive and the entries, ready to print as it stands.
 */
export class ZipError extends Error {
  override readonly name = 'ZipError';
}

/** One archive entry after its path has been proven safe. */
interface SafeEntry {
  /** The entry name as the archive holds it. */
  readonly name: string;
  /** The path's segments, with `.` and `..` resolved away. */
  readonly segments: readonly string[];
  /** The entry's bytes; `undefined` for a directory entry. */
  readonly data: Uint8Array | undefined;
}

/** An entry name that would write outside the target, and why. */
interface UnsafeEntry {
  readonly name: string;
  readonly reason: string;
}

/** A Windows drive prefix such as `C:` at the start of a name. */
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * Resolves an entry name to segments inside the target, or returns why it
 * cannot be placed there.
 */
function entrySegments(name: string): readonly string[] | string {
  if (name.includes('\0')) {
    return 'holds a NUL byte';
  }

  const posixName = name.replaceAll('\\', '/');

  if (posixName.startsWith('/')) {
    return 'is an absolute path';
  }

  if (DRIVE_LETTER.test(posixName)) {
    return 'starts with a drive letter';
  }

  const segments: string[] = [];

  for (const segment of posixName.split('/')) {
    if (segment === '..') {
      if (segments.pop() === undefined) {
        return 'climbs out of the target';
      }
    } else if (segment !== '' && segment !== '.') {
      segments.push(segment);
    }
  }

  return segments;
}

/** Reads the archive, keeping every entry name in order, duplicates too. */
function readArchive(zipPath: string): { names: readonly string[]; files: Record<string, Uint8Array> } {
  const names: string[] = [];

  try {
    const files = unzipSync(readFileSync(zipPath), {
      filter: (file) => {
        names.push(file.name);

        return true;
      },
    });

    return { names, files };
  } catch (error) {
    const reason = error instanceof Error
      ? error.message
      : String(error);

    throw new ZipError(`${zipPath}: cannot read the archive (${reason})`, { cause: error });
  }
}

function describeUnsafe(zipPath: string, unsafe: readonly UnsafeEntry[]): string {
  const listed = unsafe.map((entry) => `  ${JSON.stringify(entry.name)} ${entry.reason}`);

  return [`${zipPath}: refused, nothing was written; these entries leave the target:`, ...listed].join('\n');
}

/** Checks every entry; throws naming each unsafe one, else returns them all. */
function validateEntries(zipPath: string, archive: ReturnType<typeof readArchive>): readonly SafeEntry[] {
  const safe: SafeEntry[] = [];
  const unsafe: UnsafeEntry[] = [];

  for (const name of archive.names) {
    const segments = entrySegments(name);

    if (typeof segments === 'string') {
      unsafe.push({ name, reason: segments });
    } else if (name.endsWith('/') || name.endsWith('\\')) {
      safe.push({ name, segments, data: undefined });
    } else if (segments.length === 0) {
      unsafe.push({ name, reason: 'names the target itself' });
    } else {
      safe.push({ name, segments, data: archive.files[name] });
    }
  }

  if (unsafe.length > 0) {
    throw new ZipError(describeUnsafe(zipPath, unsafe));
  }

  return safe;
}

/** The top-level folder macOS Finder fills with AppleDouble metadata. */
const MACOS_METADATA_DIR = '__MACOSX';

/** The folder-view settings file macOS Finder leaves in every folder. */
const DS_STORE = '.DS_Store';

/** Why an entry is left out, or `undefined` when it is kept. */
function dropReason(entry: SafeEntry): DroppedEntry['reason'] | undefined {
  const [top] = entry.segments;
  const isFile = entry.data !== undefined;

  if (top === MACOS_METADATA_DIR && (entry.segments.length > 1 || !isFile)) {
    return 'macos-metadata';
  }

  if (isFile && entry.segments.at(-1) === DS_STORE) {
    return 'ds-store';
  }

  return undefined;
}

/**
 * Splits off the entries macOS Finder adds: everything under a top-level
 * `__MACOSX/` folder, the folder's own entry included, and every
 * `.DS_Store` file at any depth.
 */
function dropFinderMetadata(entries: readonly SafeEntry[]): { kept: readonly SafeEntry[]; dropped: DroppedEntry[] } {
  const kept: SafeEntry[] = [];
  const dropped: DroppedEntry[] = [];

  for (const entry of entries) {
    const reason = dropReason(entry);

    if (reason === undefined) {
      kept.push(entry);
    } else {
      dropped.push({ path: entry.name, reason });
    }
  }

  return { kept, dropped: dropped.sort(byPath) };
}

/**
 * Strips a lone top-level folder: when every entry sits under the same
 * first segment and no file sits at the root, that segment is removed.
 */
function unwrapLoneFolder(entries: readonly SafeEntry[]): readonly SafeEntry[] {
  const tops = new Set(entries.flatMap((entry) => entry.segments.slice(0, 1)));
  const fileAtRoot = entries.some((entry) => entry.data !== undefined && entry.segments.length === 1);

  if (tops.size !== 1 || fileAtRoot) {
    return entries;
  }

  return entries.map((entry) => ({ ...entry, segments: entry.segments.slice(1) }));
}

/**
 * Refuses two files at one path, and a file where another entry needs a
 * directory, so no write can fail halfway through the archive.
 */
function assertNoCollisions(zipPath: string, entries: readonly SafeEntry[]): void {
  const filePaths = new Set<string>();
  const clashes = new Set<string>();

  for (const entry of entries.filter((candidate) => candidate.data !== undefined)) {
    const path = entry.segments.join('/');

    if (filePaths.has(path)) {
      clashes.add(path);
    }

    filePaths.add(path);
  }

  for (const entry of entries) {
    const directoryDepth = entry.data === undefined
      ? entry.segments.length
      : entry.segments.length - 1;

    for (let depth = 1; depth <= directoryDepth; depth += 1) {
      const directory = entry.segments.slice(0, depth).join('/');

      if (filePaths.has(directory)) {
        clashes.add(directory);
      }
    }
  }

  if (clashes.size > 0) {
    const listed = [...clashes].sort().map((path) => JSON.stringify(path));

    throw new ZipError(`${zipPath}: refused, nothing was written; more than one entry claims ${listed.join(', ')}`);
  }
}

/**
 * Refuses two entries, or two entries' folders, whose paths differ only in
 * case, which a case-insensitive file system cannot hold side by side.
 */
function assertNoCaseCollisions(zipPath: string, entries: readonly SafeEntry[]): void {
  const collisions = findCaseCollisions(entries.map((entry) => entry.segments.join('/')));

  if (collisions.length > 0) {
    throw new ZipError(describeCaseCollisions(zipPath, collisions));
  }
}

/** Joins segments under the target and proves the result stays inside it. */
function placeInside(root: string, segments: readonly string[]): string {
  const target = resolve(root, ...segments);
  const fromRoot = relative(root, target);

  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new ZipError(`${target} does not resolve inside ${root}`);
  }

  return target;
}

/** What {@link extractZip} placed and what it left out. */
export interface ExtractResult {
  /** The placed files' paths, POSIX-relative to the target, sorted. */
  readonly files: string[];
  /** The entries left out, archive names as the zip holds them, sorted by path. */
  readonly dropped: DroppedEntry[];
}

/**
 * Extracts the zip at `zipPath` into `targetDir`.
 *
 * Every entry is read and its path proven to resolve inside `targetDir`
 * before anything is written; an escaping entry, an unreadable archive, an
 * archive with no files, two entries claiming one path, or two paths or
 * folder prefixes differing only in case throws a {@link ZipError} and
 * leaves `targetDir` as it was (not even created). Entries under a
 * top-level `__MACOSX/` folder and `.DS_Store` files at any depth are
 * dropped, and only then is a lone top-level folder unwrapped and the case
 * check run. An escaping entry refuses the archive even when it would have
 * been dropped.
 * `targetDir` is created when missing.
 * Files are written with the `wx` flag, so an existing file or symlink at an
 * entry's path is never overwritten or followed; the caller is expected to
 * hand over an empty directory.
 *
 * @returns The placed files and the dropped entries, each sorted by path.
 */
export function extractZip(zipPath: string, targetDir: string): ExtractResult {
  const { kept, dropped } = dropFinderMetadata(validateEntries(zipPath, readArchive(zipPath)));
  const entries = unwrapLoneFolder(kept);
  const files = entries.filter((entry) => entry.data !== undefined);

  if (files.length === 0) {
    throw new ZipError(`${zipPath}: the archive holds no files`);
  }

  assertNoCollisions(zipPath, entries);
  assertNoCaseCollisions(zipPath, entries);

  const root = resolve(targetDir);
  const placed = entries
    .filter((entry) => entry.segments.length > 0)
    .map((entry) => ({ path: placeInside(root, entry.segments), data: entry.data }));

  mkdirSync(root, { recursive: true });

  for (const { path, data } of placed) {
    if (data === undefined) {
      mkdirSync(path, { recursive: true });
    } else {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, data, { flag: 'wx' });
    }
  }

  return { files: files.map((entry) => entry.segments.join('/')).sort(), dropped };
}
