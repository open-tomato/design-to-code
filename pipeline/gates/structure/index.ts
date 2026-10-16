/**
 * The structure gate: runs the four structure rules over a library and
 * writes what they found as `structure` gate results.
 *
 * The rules are {@link STRUCTURE_RULES}, in that order: `layer-imports`,
 * `shared-variants`, `layout-children-only` and `no-pages-folder`. Each
 * reads the components `listLibrary` lists under `<target.dir>/src/<level>/`
 * and returns findings naming the component they belong to.
 *
 * Every listed component gets one `structure.json` under
 * `<target.dir>/gate-results/<component>/`: a `fail` carrying its findings
 * when it has any, a `pass` otherwise. The pseudo-component `_library` gets
 * one only when it holds a finding; a `_library` result left by an earlier
 * run is removed when this run finds nothing there, so a stale failure is
 * never read as current. A finding naming a component the library does not
 * list is still written, under that name, after the listed components.
 * Two components sharing a name in different levels share one result file,
 * their findings merged.
 *
 * When the library holds zero files, the gate fails with a
 * `scanned-zero-files` finding under `_library`, so an empty or misplaced
 * library never reads as a pass. Every result carries the whole run's
 * duration as its `durationMs`.
 *
 * @packageDocumentation
 */

import type { GateFinding, GateResult } from '../result.ts';
import type { StructureFinding, StructureRule } from './rules/rule.ts';

import { rmSync } from 'node:fs';

import { groupFindings } from '../findings.ts';
import { listLibrary, LIBRARY_SOURCE_DIR } from '../library.ts';
import { gateResultPath, LIBRARY_COMPONENT, scannedZeroFilesFinding, writeGateResult } from '../result.ts';

import { layerImports } from './rules/layer-imports.ts';
import { layoutChildrenOnly } from './rules/layout-children-only.ts';
import { noPagesFolder } from './rules/no-pages-folder.ts';
import { sharedVariants } from './rules/shared-variants.ts';

/** The gate name, as written in results and result file names. */
export const STRUCTURE_GATE = 'structure';

/** The structure rules, in the order the gate runs them and lists their findings. */
export const STRUCTURE_RULES: readonly StructureRule[] = [layerImports, sharedVariants, layoutChildrenOnly, noPagesFolder];

/** What the structure gate reads. */
export interface StructureGateOptions {
  /** The library's root, the config's `target.dir`; results are written under it. */
  readonly targetDir: string;
  /** The level folder names, lowest first: the config's `levels`. */
  readonly levels: readonly string[];
  /** The clock, in milliseconds, used for `durationMs`; `performance.now` when left out. */
  readonly now?: () => number;
}

/** What one run of the structure gate wrote. */
export interface StructureGateRun {
  /** `fail` when any result failed, `pass` otherwise. */
  readonly status: 'pass' | 'fail';
  /** Every result written, listed components first in library order, then any other, then `_library`. */
  readonly results: readonly GateResult[];
  /** The absolute path of each result, in the order of `results`. */
  readonly paths: readonly string[];
  /** The number of files the gate scanned. */
  readonly scannedFiles: number;
}

/** The findings of every rule, grouped by component, with the zero-files finding added under `_library`. */
function groupStructureFindings(found: readonly StructureFinding[], scannedFiles: number): ReadonlyMap<string, readonly GateFinding[]> {
  const zeroFiles: readonly StructureFinding[] = scannedFiles === 0
    ? [{ component: LIBRARY_COMPONENT, finding: scannedZeroFilesFinding(LIBRARY_SOURCE_DIR) }]
    : [];

  return groupFindings([...zeroFiles, ...found].map(({ component, finding }) => [component, finding] as const));
}

/** The component names to write a result for, in result order. */
function resultComponents(listed: readonly string[], grouped: ReadonlyMap<string, readonly GateFinding[]>): readonly string[] {
  const unique = [...new Set(listed)].filter((name) => name !== LIBRARY_COMPONENT);
  const others = [...grouped.keys()].filter((name) => name !== LIBRARY_COMPONENT && !unique.includes(name));
  const library = grouped.has(LIBRARY_COMPONENT)
    ? [LIBRARY_COMPONENT]
    : [];

  return [...unique, ...others, ...library];
}

/**
 * Runs the structure rules over the library at `targetDir`, read through
 * `levels`, and writes one `structure.json` per component, plus one for
 * `_library` when it holds a finding.
 *
 * @throws when a level is not a single folder name, when a library file
 *   cannot be read, or when a result cannot be written.
 */
export function runStructureGate(options: StructureGateOptions): StructureGateRun {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const library = listLibrary(options.targetDir, options.levels);
  const input = { targetDir: options.targetDir, levels: options.levels, components: library.components };
  const grouped = groupStructureFindings(STRUCTURE_RULES.flatMap((rule) => rule(input)), library.scannedFiles);
  const durationMs = Math.max(0, now() - startedAt);

  const results = resultComponents(library.components.map((component) => component.name), grouped).map(
    (component): GateResult => {
      const findings = grouped.get(component) ?? [];

      return {
        gate: STRUCTURE_GATE,
        component,
        status: findings.length > 0
          ? 'fail'
          : 'pass',
        findings,
        durationMs,
      };
    },
  );

  if (!grouped.has(LIBRARY_COMPONENT)) {
    rmSync(gateResultPath(options.targetDir, LIBRARY_COMPONENT, STRUCTURE_GATE), { force: true });
  }

  const paths = results.map((result) => writeGateResult(options.targetDir, result));
  const status = results.some((result) => result.status === 'fail')
    ? 'fail'
    : 'pass';

  return { status, results, paths, scannedFiles: library.scannedFiles };
}
