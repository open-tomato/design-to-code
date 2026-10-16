/**
 * The whole-tree walk discovery starts from: every regular file under a
 * project's source dir, at any depth, as a sorted list of POSIX paths
 * relative to it.
 *
 * Six top-level entries are left out because the pipeline writes them, not
 * the export: the import record's `.import/` directory, the discovery
 * report `discovery.json` itself, the serve verb's `.serve.json` and
 * `serve-check.json`, so serving never changes what discovery reports, and
 * the seed verb's `seed-manifest.json` and `seed-rejected.json`, so seeding
 * never adds assets to it either. The same names deeper in the tree belong
 * to the export and are walked like any other file.
 *
 * @packageDocumentation
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { RECORD_DIR } from '../import/record.ts';

import { AssessRefusedError } from './errors.ts';

/** The discovery report's file name inside the source dir. */
export const DISCOVERY_FILE = 'discovery.json';

/** The running server's record file name inside the source dir. */
export const SERVE_FILE = '.serve.json';

/** The serve health check's report file name inside the source dir. */
export const SERVE_CHECK_FILE = 'serve-check.json';

/** The seed verb's component manifest file name inside the source dir. */
export const SEED_MANIFEST_FILE = 'seed-manifest.json';

/** The seed verb's rejected-candidates file name inside the source dir. */
export const SEED_REJECTED_FILE = 'seed-rejected.json';

/** The top-level entries of the source dir that the walk leaves out. */
export const WALK_SKIPPED = [
  RECORD_DIR,
  DISCOVERY_FILE,
  SERVE_FILE,
  SERVE_CHECK_FILE,
  SEED_MANIFEST_FILE,
  SEED_REJECTED_FILE,
] as const;

/** Orders two paths code unit by code unit, independent of locale. */
export function comparePaths(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right
    ? -1
    : 1;
}

function isSkipped(relativePath: string): boolean {
  return (WALK_SKIPPED as readonly string[]).includes(relativePath);
}

function collectFiles(rootDir: string, relativeDir: string): readonly string[] {
  const entries = readdirSync(join(rootDir, relativeDir), { withFileTypes: true });

  return entries.flatMap((entry) => {
    const relativePath = relativeDir === ''
      ? entry.name
      : `${relativeDir}/${entry.name}`;

    if (isSkipped(relativePath)) {
      return [];
    }

    if (entry.isDirectory()) {
      return collectFiles(rootDir, relativePath);
    }

    if (entry.isFile()) {
      return [relativePath];
    }

    throw new AssessRefusedError(relativePath, `${relativePath}: not a regular file or directory; cannot assess it`);
  });
}

/**
 * Lists every regular file under `sourceDir`.
 *
 * Paths are POSIX-relative to `sourceDir` and sorted by code unit, so the
 * same tree always gives the same list. The top-level `.import/` directory,
 * `discovery.json`, `.serve.json`, `serve-check.json`, `seed-manifest.json`
 * and `seed-rejected.json` are skipped
 * ({@link WALK_SKIPPED}). Any entry that
 * is neither a regular file nor a directory, such as a symlink, throws, so
 * discovery never silently misses a file.
 *
 * @throws AssessRefusedError when an entry is neither a regular file nor a
 * directory; its `path` is the entry's path relative to `sourceDir`.
 * @throws Error the system error (`ENOENT`, `EACCES`, ...) when a directory
 * cannot be read, such as a `sourceDir` that does not exist.
 */
export function walkSourceDir(sourceDir: string): string[] {
  return [...collectFiles(sourceDir, '')].sort(comparePaths);
}
