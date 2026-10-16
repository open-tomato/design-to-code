/**
 * The `no-pages-folder` structure rule: the library holds components, never
 * pages, so no directory named `pages` may sit anywhere under its `src`.
 *
 * The rule walks `<target.dir>/src` itself rather than the component list,
 * since a `pages/` folder need not be a level folder nor hold a component.
 * Every directory named exactly `pages`, at any depth, is one finding under
 * the pseudo-component `_library`, naming the folder's path (POSIX-relative
 * to `target.dir`) with no line. A `pages` folder inside another is a
 * finding of its own. Symbolic links are not followed, and a library with
 * no `src` has no finding here.
 *
 * @packageDocumentation
 */

import type { StructureFinding, StructureRuleInput } from './rule.ts';

import { existsSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import { LIBRARY_SOURCE_DIR } from '../../library.ts';
import { LIBRARY_COMPONENT } from '../../result.ts';

/** The rule name written in each finding. */
export const NO_PAGES_FOLDER_RULE = 'no-pages-folder';

/** The directory name the rule refuses. */
const PAGES_DIR = 'pages';

/** Every directory under `relativeDir` (POSIX, relative to `targetDir`), depth first, in name order. */
function directoriesUnder(targetDir: string, relativeDir: string): readonly string[] {
  return readdirSync(join(targetDir, relativeDir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      const child = posix.join(relativeDir, name);

      return [child, ...directoriesUnder(targetDir, child)];
    });
}

/**
 * Finds every directory named `pages` under the library's `src`, one
 * `_library` finding each, in depth-first name order.
 *
 * @throws when a directory under `src` cannot be read.
 */
export function noPagesFolder(input: StructureRuleInput): readonly StructureFinding[] {
  if (!existsSync(join(input.targetDir, LIBRARY_SOURCE_DIR))) {
    return [];
  }

  return directoriesUnder(input.targetDir, LIBRARY_SOURCE_DIR)
    .filter((dir) => posix.basename(dir) === PAGES_DIR)
    .map((dir) => ({
      component: LIBRARY_COMPONENT,
      finding: {
        rule: NO_PAGES_FOLDER_RULE,
        file: dir,
        line: null,
        message: `${dir} is a pages folder; the library holds components only, so pages live in the app that uses it`,
      },
    }));
}
