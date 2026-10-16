/**
 * What every structure rule reads and returns.
 *
 * A rule is a function from a {@link StructureRuleInput} (the library's
 * components, the level order and where the library lives) to the
 * {@link StructureFinding}s it found, each naming the component it belongs
 * to so the gate can write one result per component.
 *
 * @packageDocumentation
 */

import type { LibraryComponent } from '../../library.ts';
import type { GateFinding } from '../../result.ts';

/** What a structure rule reads. */
export interface StructureRuleInput {
  /** The library's root, the config's `target.dir`; component paths are relative to it. */
  readonly targetDir: string;
  /** The level folder names, lowest first: a level's rank is its index here. */
  readonly levels: readonly string[];
  /** The library's components, as `listLibrary` lists them. */
  readonly components: readonly LibraryComponent[];
}

/** One finding of a structure rule, and the component whose result it goes in. */
export interface StructureFinding {
  /** The component the finding belongs to, or `_library` when it belongs to none. */
  readonly component: string;
  /** The finding itself, as written in the gate result. */
  readonly finding: GateFinding;
}

/** A structure rule: the library in, its findings out. */
export type StructureRule = (input: StructureRuleInput) => readonly StructureFinding[];
