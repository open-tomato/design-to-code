/**
 * The stale-result sweep: removes each `<target.dir>/gate-results/<name>/`
 * folder whose component the library no longer holds, so a component
 * deleted from the library stops being reported by the results it left.
 *
 * The sweep reads only the direct entries of `gate-results/`. It keeps the
 * folder of every component it is given and the {@link LIBRARY_COMPONENT}
 * folder, removes every other folder with all it holds, and leaves files
 * directly inside `gate-results/` alone. A symbolic link under any other
 * name is removed as a link, never followed, so the sweep never deletes
 * anything outside `gate-results/`. For the same reason a `gate-results`
 * that is itself a symbolic link, or not a folder, is left alone, and a
 * missing one removes nothing.
 *
 * @packageDocumentation
 */

import type { Dirent } from 'node:fs';

import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { GATE_RESULTS_DIR, LIBRARY_COMPONENT } from './result.ts';

/** Whether `error` is a file system error carrying `code`. */
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Whether `absolutePath` is a real folder: not missing, not a file, not a symbolic link. */
function isRealFolder(absolutePath: string): boolean {
  try {
    return lstatSync(absolutePath).isDirectory();
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return false;
    }

    throw error;
  }
}

/** Whether the sweep removes `entry`: a folder or symbolic link not named in `kept`. */
function isStale(entry: Dirent, kept: ReadonlySet<string>): boolean {
  if (kept.has(entry.name)) {
    return false;
  }

  return entry.isDirectory() || entry.isSymbolicLink();
}

/**
 * Removes each entry of `<targetDir>/gate-results/` that is a folder or a
 * symbolic link and names neither one of `componentNames` (the components
 * of the library just read) nor {@link LIBRARY_COMPONENT}. A folder goes
 * with everything inside it; a symbolic link goes as a link, its target
 * untouched.
 *
 * @returns the names of the entries removed, sorted by code unit; none when
 *   `gate-results/` is missing, a file or a symbolic link.
 * @throws when `gate-results/` or an entry cannot be read or removed, such
 *   as for lack of permission.
 */
export function removeStaleResults(targetDir: string, componentNames: readonly string[]): readonly string[] {
  const resultsDir = join(targetDir, GATE_RESULTS_DIR);

  if (!isRealFolder(resultsDir)) {
    return [];
  }

  const kept = new Set([...componentNames, LIBRARY_COMPONENT]);
  const stale = readdirSync(resultsDir, { withFileTypes: true })
    .filter((entry) => isStale(entry, kept))
    .map((entry) => entry.name)
    .sort((left, right) => (left < right
      ? -1
      : 1));

  for (const name of stale) {
    rmSync(join(resultsDir, name), { recursive: true, force: true });
  }

  return stale;
}
