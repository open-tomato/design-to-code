/**
 * The library model every gate reads: the components of a library under
 * `<target.dir>/src/<level folder>/<Name>/`, and how many files they hold.
 *
 * The level folders are the project config's `levels`, lowest first. Every
 * folder directly inside a level folder is listed as a component named after
 * the folder, whether or not it holds `<Name>.tsx`, so a gate can report the
 * missing file rather than never see the folder. Files directly inside a
 * level folder belong to no component and are not listed. A missing `src`
 * or level folder lists nothing rather than throwing, so an empty library
 * reads as zero files scanned, which every gate fails on.
 *
 * Paths are POSIX-relative to `target.dir`, as a finding's `file` is. Only
 * regular files and real folders are read: a symbolic link is skipped, so
 * the scan never leaves `target.dir`. Components come in `levels` order,
 * then by name; each component's files come sorted.
 *
 * @packageDocumentation
 */

import type { Dirent } from 'node:fs';

import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

/** The folder under `target.dir` that holds the level folders. */
export const LIBRARY_SOURCE_DIR = 'src';

/** One component of a library: its folder and every file inside it. */
export interface LibraryComponent {
  /** The component's name: its folder's name. */
  readonly name: string;
  /** The level folder holding the component, one of the config's `levels`. */
  readonly level: string;
  /** The component's folder, POSIX-relative to `target.dir`. */
  readonly dir: string;
  /** Every file under the component's folder, POSIX-relative to `target.dir`, sorted. */
  readonly files: readonly string[];
}

/** A library's components and the number of files a gate scanned in them. */
export interface Library {
  /** The components, in `levels` order, then by name. */
  readonly components: readonly LibraryComponent[];
  /** The number of files across every component. */
  readonly scannedFiles: number;
}

/** Compares two strings by code unit, so the order is the same on every machine. */
function byCodeUnit(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right
    ? -1
    : 1;
}

/** The entries of `absoluteDir`, or none when it is missing or not a folder. */
function readEntries(absoluteDir: string): readonly Dirent[] {
  try {
    return readdirSync(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return [];
    }

    throw error;
  }
}

/** Every regular file under `relativeDir`, POSIX-relative to `targetDir`. */
function listFiles(targetDir: string, relativeDir: string): readonly string[] {
  return readEntries(join(targetDir, relativeDir)).flatMap((entry) => {
    const path = posix.join(relativeDir, entry.name);

    if (entry.isDirectory()) {
      return listFiles(targetDir, path);
    }

    return entry.isFile()
      ? [path]
      : [];
  });
}

/** The components in one level folder, by name. */
function listLevel(targetDir: string, level: string): readonly LibraryComponent[] {
  const levelDir = posix.join(LIBRARY_SOURCE_DIR, level);

  return readEntries(join(targetDir, levelDir))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(byCodeUnit)
    .map((name) => {
      const dir = posix.join(levelDir, name);

      return { name, level, dir, files: [...listFiles(targetDir, dir)].sort(byCodeUnit) };
    });
}

/** Whether `level` names one folder: non-empty, no separator, not `.` or `..`. */
function isSingleSegment(level: string): boolean {
  return level !== '' && level !== '.' && level !== '..' && !level.includes('/') && !level.includes('\\');
}

/**
 * Lists the components of the library at `targetDir` (the config's
 * `target.dir`), looking in `<targetDir>/src/<level>/` for each of `levels`
 * (the config's `levels`), and counts the files they hold.
 *
 * @throws when a level is not a single folder name, since it would read
 *   outside `<targetDir>/src`.
 * @throws when a folder exists but cannot be read, such as for lack of
 *   permission; a missing folder lists nothing.
 */
export function listLibrary(targetDir: string, levels: readonly string[]): Library {
  const unsafe = levels.find((level) => !isSingleSegment(level));

  if (unsafe !== undefined) {
    throw new Error(`level ${JSON.stringify(unsafe)} is not a single folder name`);
  }

  const components = levels.flatMap((level) => listLevel(targetDir, level));
  const scannedFiles = components.reduce((total, component) => total + component.files.length, 0);

  return { components, scannedFiles };
}
