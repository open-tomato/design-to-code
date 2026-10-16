/**
 * The result helpers every gate shares: placing a file against
 * `target.dir`, grouping findings by the component they go to, and turning
 * one component's findings into its {@link GateResult}.
 *
 * What a gate checks, and which component a finding goes to, stays each
 * gate's own business; this module only does the bookkeeping around it.
 *
 * @packageDocumentation
 */

import type { GateFinding, GateName, GateResult } from './result.ts';

import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * `file` POSIX-relative to `targetDir`, or `null` when it lies outside it.
 *
 * A relative `file` is read against `targetDir`. `targetDir` itself, and
 * any path that climbs out of it or sits on another root, give `null`.
 */
export function targetRelative(targetDir: string, file: string): string | null {
  const path = relative(resolve(targetDir), resolve(targetDir, file));

  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    return null;
  }

  return path.split(sep).join('/');
}

/**
 * `pairs` grouped by component: each component maps to its findings in the
 * order they came, and the map's keys run in the order each component was
 * first seen. `pairs` is left as it was.
 */
export function groupFindings(pairs: readonly (readonly [string, GateFinding])[]): ReadonlyMap<string, readonly GateFinding[]> {
  return pairs.reduce(
    (groups, [component, finding]) => new Map(groups).set(component, [...(groups.get(component) ?? []), finding]),
    new Map<string, readonly GateFinding[]>(),
  );
}

/**
 * The `gate` result for `component`: `fail` with `findings` when there are
 * any, `pass` with none otherwise. The result is not validated here;
 * writing it through `writeGateResult` does that.
 */
export function toResult(gate: GateName, component: string, findings: readonly GateFinding[], durationMs: number): GateResult {
  return {
    gate,
    component,
    status: findings.length > 0
      ? 'fail'
      : 'pass',
    findings,
    durationMs,
  };
}
