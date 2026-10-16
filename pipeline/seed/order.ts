/**
 * Extraction order for accepted seed entries.
 *
 * {@link extractionOrder} sorts by level rank (lowest first), then page
 * path, then name, all by code unit. Validation rejects any entry that
 * contains another of equal or higher level, so this order places each
 * component after everything it contains on its page;
 * {@link assertContainmentOrder} checks that and throws on a violation.
 *
 * @packageDocumentation
 */

import type { Level } from './schema.ts';

import { levelRank } from './schema.ts';

/** The fields ordering reads from an entry. */
export interface OrderableEntry {
  /** The component name, unique across the manifest. */
  readonly name: string;
  /** The component's atomic-design level. */
  readonly level: Level;
  /** The kept page path the component lives on. */
  readonly page: string;
}

/** Compares two strings by code unit, locale-free. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right
    ? 1
    : 0;
}

/** Orders two entries by level rank, then page path, then name. */
function compareEntries(left: OrderableEntry, right: OrderableEntry): number {
  return levelRank(left.level) - levelRank(right.level)
    || compareCodeUnits(left.page, right.page)
    || compareCodeUnits(left.name, right.name);
}

/**
 * Returns a new array of `entries` in extraction order: level rank, then
 * page path, then name. The input array is left unmodified.
 */
export function extractionOrder<T extends OrderableEntry>(entries: readonly T[]): T[] {
  return [...entries].sort(compareEntries);
}

/**
 * Throws when an entry in `ordered` comes before an entry it contains.
 * `contains` maps a component name to the names of the components its root
 * contains; names missing from `ordered` are ignored. The error names both
 * entries, container first.
 */
export function assertContainmentOrder(
  ordered: readonly OrderableEntry[],
  contains: ReadonlyMap<string, readonly string[]>,
): void {
  const position = new Map(ordered.map((entry, index) => [entry.name, index]));
  for (const [container, contained] of contains) {
    const containerIndex = position.get(container);
    if (containerIndex === undefined) {
      continue;
    }
    for (const inner of contained) {
      const innerIndex = position.get(inner);
      if (innerIndex !== undefined && innerIndex > containerIndex) {
        throw new Error(
          `extraction order violated: "${container}" precedes "${inner}", which it contains`,
        );
      }
    }
  }
}
