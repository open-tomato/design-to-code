/**
 * Case-folded collisions: two paths of one export that differ only in case.
 *
 * A case-sensitive file system holds `a.html` beside `A.html`, and `Pages/`
 * beside `pages/`; a case-insensitive one (the macOS and Windows default)
 * holds only one of each, so the same export would import differently from
 * machine to machine. Import refuses such an export whole, before anything
 * is written, naming both spellings.
 *
 * Every path is folded with `toLowerCase()`, whole and with its extension,
 * and so is every folder prefix of it: `Pages/a.html` yields the keys
 * `pages` and `pages/a.html`. Two different original spellings under one
 * key collide. `Button.tsx` beside `button.css` folds to two keys and
 * imports.
 *
 * @packageDocumentation
 */

/** Two or more spellings of one path that fold to the same key. */
export interface CaseCollision {
  /** The folded key, lower case. */
  readonly key: string;
  /** The original spellings, sorted, at least two. */
  readonly spellings: readonly string[];
}

/** Every path a POSIX path spans: its folder prefixes, then itself. */
function prefixesOf(path: string): readonly string[] {
  const segments = path.split('/').filter((segment) => segment !== '');

  return segments.map((_segment, index) => segments.slice(0, index + 1).join('/'));
}

/**
 * Finds the paths, and the folder prefixes of the paths, whose spellings
 * differ but fold to one key.
 *
 * The same spelling given twice is not a case collision.
 *
 * @param paths - POSIX paths relative to one root, files or folders.
 * @returns One entry per colliding key, sorted by key; empty when none.
 */
export function findCaseCollisions(paths: Iterable<string>): readonly CaseCollision[] {
  const spellingsByKey = new Map<string, ReadonlySet<string>>();

  for (const spelling of [...paths].flatMap(prefixesOf)) {
    const key = spelling.toLowerCase();

    spellingsByKey.set(key, new Set([...(spellingsByKey.get(key) ?? []), spelling]));
  }

  return [...spellingsByKey.keys()]
    .sort()
    .map((key) => ({ key, spellings: [...(spellingsByKey.get(key) ?? [])].sort() }))
    .filter((collision) => collision.spellings.length > 1);
}

/**
 * The refusal message for `collisions` found in the export at `origin`,
 * one line per key naming every spelling; ready to print as it stands.
 */
export function describeCaseCollisions(origin: string, collisions: readonly CaseCollision[]): string {
  const listed = collisions.map((collision) => `  ${collision.spellings.map((spelling) => JSON.stringify(spelling)).join(' and ')}`);

  return [
    `${origin}: refused, nothing was written; these paths differ only in case, and a case-insensitive file system holds only one of each:`,
    ...listed,
  ].join('\n');
}
