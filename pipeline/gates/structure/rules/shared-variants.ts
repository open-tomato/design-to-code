/**
 * The `shared-variants` structure rule: variants shared by several
 * components belong in the lowest level.
 *
 * A component's variants file is `<Name>.variants.ts` directly in its
 * folder. Every script file of every other component is read through
 * `readRelativeImports`, and an import whose resolved target is that file
 * (written without an extension, with `.ts`, or with `.js` as TypeScript's
 * ESM resolution allows) counts its component as an importer. Imports from
 * the owner's own folder never count, and a component importing the file
 * from several places counts once.
 *
 * A variants file imported by two or more components outside its own folder
 * is one finding, written under the owning component, naming the variants
 * file at line 1 and each importer with the first file and line it imports
 * the file at, and asking for the file's promotion to the lowest level (the
 * first of `levels`). A variants file already in the lowest level is where
 * the rule asks it to be, so it is never a finding.
 *
 * @packageDocumentation
 */

import type { StructureFinding, StructureRuleInput } from './rule.ts';
import type { LibraryComponent } from '../../library.ts';

import { posix } from 'node:path';

import { readRelativeImports } from './imports.ts';

/** The rule name written in each finding. */
export const SHARED_VARIANTS_RULE = 'shared-variants';

/** The suffix after `<Name>` of a component's variants file. */
const VARIANTS_SUFFIX = '.variants.ts';

/** The fewest importing components that make a variants file shared. */
const SHARED_THRESHOLD = 2;

/** One component importing a variants file, and where it first does. */
interface Importer {
  readonly component: string;
  readonly file: string;
  readonly line: number;
}

/** The import targets that resolve to `variantsFile`: no extension, `.ts` or `.js`. */
function targetsOf(variantsFile: string): ReadonlySet<string> {
  const stem = variantsFile.slice(0, -'.ts'.length);

  return new Set([stem, variantsFile, `${stem}.js`]);
}

/** The first place `component` imports one of `targets` from, if any. */
function firstImport(
  input: StructureRuleInput,
  component: LibraryComponent,
  targets: ReadonlySet<string>,
): Importer | undefined {
  for (const file of component.files) {
    const site = readRelativeImports(input.targetDir, file).find(({ target }) => targets.has(target));

    if (site !== undefined) {
      return { component: component.name, file, line: site.line };
    }
  }

  return undefined;
}

/** The finding for `owner`'s variants file, when components outside its folder share it. */
function checkOwner(input: StructureRuleInput, owner: LibraryComponent, lowest: string): readonly StructureFinding[] {
  const variantsFile = posix.join(owner.dir, `${owner.name}${VARIANTS_SUFFIX}`);

  if (owner.level === lowest || !owner.files.includes(variantsFile)) {
    return [];
  }

  const targets = targetsOf(variantsFile);
  const importers = input.components
    .filter((component) => component.dir !== owner.dir)
    .flatMap((component) => firstImport(input, component, targets) ?? []);

  if (importers.length < SHARED_THRESHOLD) {
    return [];
  }

  const named = importers.map(({ component, file, line }) => `${component} (${file}:${line})`).join(', ');

  return [{
    component: owner.name,
    finding: {
      rule: SHARED_VARIANTS_RULE,
      file: variantsFile,
      line: 1,
      message: `${owner.name}${VARIANTS_SUFFIX} (${owner.level}) is imported by ${importers.length} components `
        + `outside its folder: ${named}; promote it to ${lowest}, the lowest level`,
    },
  }];
}

/**
 * Finds every `<Name>.variants.ts` outside the lowest level that two or more
 * components outside its own folder import. Findings come in component
 * order; importers in each message come in component order too.
 *
 * @throws when a component file cannot be read.
 */
export function sharedVariants(input: StructureRuleInput): readonly StructureFinding[] {
  const lowest = input.levels[0];

  if (lowest === undefined) {
    return [];
  }

  return input.components.flatMap((owner) => checkOwner(input, owner, lowest));
}
