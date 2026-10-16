/**
 * The `layer-imports` structure rule: a component imports only from lower
 * levels.
 *
 * Every script file in a component's folder (`.ts`, `.tsx`, `.mts`, `.cts`,
 * `.js`, `.jsx`, `.mjs`, `.cjs`, stories and variants included) is read
 * through `readRelativeImports`: each import declaration, `export … from`
 * declaration and `import()` call with a string literal, type-only ones
 * included, since a type import ties the levels together as much as a
 * value import does.
 *
 * A relative specifier is resolved against the importing file. When it
 * lands inside a level folder (`<target.dir>/src/<level>/…`, a component or
 * a file sitting directly in the level folder, such as a barrel) and
 * outside the importing component's own folder, the target level's rank
 * (its index in `levels`) must be lower than the importer's. An import of
 * the same level or a higher one is a finding naming the importing file
 * and the 1-based line the import statement starts on. A package
 * specifier, an alias, or a relative path that leaves the level folders
 * (such as `../../lib/cn`) is not a component and is never a finding.
 *
 * @packageDocumentation
 */

import type { StructureFinding, StructureRuleInput } from './rule.ts';
import type { LibraryComponent } from '../../library.ts';

import { posix } from 'node:path';

import { LIBRARY_SOURCE_DIR } from '../../library.ts';

import { isInside, readRelativeImports } from './imports.ts';

/** The rule name written in each finding. */
export const LAYER_IMPORTS_RULE = 'layer-imports';

/** The level folder `path` (POSIX-relative to `target.dir`) lies in, if any. */
function levelOf(path: string, levels: readonly string[]): string | undefined {
  return levels.find((level) => isInside(path, posix.join(LIBRARY_SOURCE_DIR, level)));
}

/** The findings of one file of `component`. */
function checkFile(input: StructureRuleInput, component: LibraryComponent, file: string): readonly StructureFinding[] {
  const ownRank = input.levels.indexOf(component.level);

  return readRelativeImports(input.targetDir, file).flatMap(({ specifier, target, line }): readonly StructureFinding[] => {
    const targetLevel = levelOf(target, input.levels);

    if (targetLevel === undefined || isInside(target, component.dir)) {
      return [];
    }

    const targetRank = input.levels.indexOf(targetLevel);

    if (targetRank < ownRank) {
      return [];
    }

    const relation = targetRank === ownRank
      ? 'its own level'
      : 'a higher level';

    return [{
      component: component.name,
      finding: {
        rule: LAYER_IMPORTS_RULE,
        file,
        line,
        message: `${component.name} (${component.level}) imports '${specifier}' from ${relation}, ${targetLevel}; `
          + 'a component imports only from components in lower levels',
      },
    }];
  });
}

/**
 * Finds every import, in every component of the library, that reaches a
 * component of the importer's own level or a higher one. Findings come in
 * component order, then file order, then source order.
 *
 * @throws when a component file cannot be read.
 */
export function layerImports(input: StructureRuleInput): readonly StructureFinding[] {
  return input.components.flatMap((component) => component.files.flatMap((file) => checkFile(input, component, file)));
}
