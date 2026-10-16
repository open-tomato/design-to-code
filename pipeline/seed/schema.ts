/**
 * The seed files' shapes: `seed-manifest.json`, the components to extract
 * in extraction order, and `seed-rejected.json`, the candidates that failed
 * validation, each with its reasons.
 *
 * A component entry names its `level` (one of {@link LEVELS}), the kept
 * `page` it lives on, the `selector` of its root on that page, further
 * `examples`, its `states`, its `variantAxes`, its `parts`, its `docText`
 * and the `origin` that proposed it (one of {@link ORIGINS}). A candidate
 * is the same shape without `origin`: agent and design-system-manifest
 * proposals are checked one by one against it, and the runner stamps the
 * origin itself.
 *
 * Every object is strict, so an unknown key fails the parse instead of
 * being stripped. `parts` and each `variantAxes` value list are sorted by
 * code unit with no duplicates, so the same proposal always serializes to
 * the same bytes. Every array is readonly. The schemas check shape only;
 * whether a selector matches on its page is the validation stage's work.
 *
 * The TypeScript types are inferred from the schemas, never written by hand.
 *
 * @packageDocumentation
 */

import { z } from 'zod';

import { relativePath } from '../assess/schema.ts';

/** The component levels, lowest first. */
export const LEVELS = ['particle', 'atom', 'molecule', 'organism', 'template', 'layout'] as const;

/** The interactions an `action` state drives on its target. */
export const STATE_ACTIONS = ['hover', 'focus', 'press', 'click'] as const;

/** Where an entry came from: page markers, a design-system manifest or the agent. */
export const ORIGINS = ['markers', 'manifest', 'agent'] as const;

/** Why a candidate was rejected; each reason in `seed-rejected.json` carries one. */
export const REJECTION_CODES = [
  'invalid-shape',
  'duplicate-name',
  'page-not-kept',
  'selector-no-match',
  'selector-multi-match',
  'example-no-match',
  'contains-equal-or-higher',
  'state-unresolved',
  'missing-level',
  'unlocated',
] as const;

/** A component level. */
export type Level = (typeof LEVELS)[number];

/** An interaction an `action` state drives. */
export type StateAction = (typeof STATE_ACTIONS)[number];

/** Where an entry came from. */
export type Origin = (typeof ORIGINS)[number];

/** Why a candidate was rejected. */
export type RejectionCode = (typeof REJECTION_CODES)[number];

/**
 * The rank of `level` in {@link LEVELS}: 0 for `particle` up to 5 for
 * `layout`. A higher rank may contain a lower one, never the reverse.
 */
export function levelRank(level: Level): number {
  return LEVELS.indexOf(level);
}

const SORTED_ERROR = 'must be sorted by code unit with no duplicates';

/** True when `values` is strictly ascending by code unit: sorted, unique. */
function isStrictlyAscending(values: readonly string[]): boolean {
  return values.every((value, index) => {
    const previous = values[index - 1];

    return previous === undefined || previous < value;
  });
}

const nonEmptyString = z.string().min(1);

const selector = nonEmptyString;

const sortedUniqueNames = z
  .array(nonEmptyString)
  .readonly()
  .refine(isStrictlyAscending, { error: SORTED_ERROR });

/** A root on the page that shows the component in this state, statically. */
const exampleStateSchema = z.strictObject({
  name: nonEmptyString,
  mode: z.literal('example'),
  selector,
});

/** An interaction driven on `target`, one element inside the component. */
const actionStateSchema = z.strictObject({
  name: nonEmptyString,
  mode: z.literal('action'),
  action: z.enum(STATE_ACTIONS),
  target: selector,
});

const stateSchema = z.discriminatedUnion('mode', [exampleStateSchema, actionStateSchema]);

/**
 * Validates one proposed component, before its origin is stamped.
 *
 * - `name` — the component name, unique across the manifest.
 * - `level` — one of {@link LEVELS}.
 * - `page` — the kept page the component is read from, source-dir relative.
 * - `selector` — the component root on `page`.
 * - `examples` — selectors of further instances on `page`.
 * - `states` — `{ name, mode: 'example', selector }` or
 *   `{ name, mode: 'action', action, target }`, action one of
 *   {@link STATE_ACTIONS}.
 * - `variantAxes` — axis name to a non-empty list of values, sorted, unique.
 * - `parts` — part names, sorted, unique.
 * - `docText` — paragraph strings in document order.
 */
export const candidateSchema = z.strictObject({
  name: nonEmptyString,
  level: z.enum(LEVELS),
  page: relativePath,
  selector,
  examples: z.array(selector).readonly(),
  states: z.array(stateSchema).readonly(),
  variantAxes: z.record(nonEmptyString, sortedUniqueNames.refine((values) => values.length > 0, {
    error: 'must list at least one value',
  })),
  parts: sortedUniqueNames,
  docText: z.array(nonEmptyString).readonly(),
});

/** Validates one manifest entry: a candidate with its `origin` stamped. */
export const componentEntrySchema = candidateSchema.extend({
  origin: z.enum(ORIGINS),
});

/** True when no two entries share a name. */
function hasUniqueNames(entries: readonly { name: string }[]): boolean {
  return new Set(entries.map((entry) => entry.name)).size === entries.length;
}

/**
 * Validates a whole `seed-manifest.json`: `generatedAt`, an ISO 8601
 * date-time, and `components` in extraction order, names unique.
 */
export const seedManifestSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  components: z
    .array(componentEntrySchema)
    .readonly()
    .refine(hasUniqueNames, { error: 'component names must be unique' }),
});

/** One reason a candidate was rejected: a {@link REJECTION_CODES} code and what it found. */
const rejectionReasonSchema = z.strictObject({
  code: z.enum(REJECTION_CODES),
  detail: nonEmptyString,
});

/**
 * Validates a whole `seed-rejected.json`: `generatedAt`, an ISO 8601
 * date-time, and `rejected`, each `{ candidate, reasons }` where
 * `candidate` is the proposal as it came, any JSON, and `reasons` holds at
 * least one reason.
 */
export const seedRejectedSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  rejected: z
    .array(z.strictObject({
      candidate: z.json(),
      reasons: z.array(rejectionReasonSchema).min(1)
        .readonly(),
    }))
    .readonly(),
});

/** One proposed component, before its origin is stamped. */
export type Candidate = z.infer<typeof candidateSchema>;

/** One manifest entry. */
export type ComponentEntry = z.infer<typeof componentEntrySchema>;

/** One state of a component, by static example or by action. */
export type ComponentState = ComponentEntry['states'][number];

/** A parsed `seed-manifest.json`. */
export type SeedManifest = z.infer<typeof seedManifestSchema>;

/** A parsed `seed-rejected.json`. */
export type SeedRejected = z.infer<typeof seedRejectedSchema>;

/** One rejected candidate with its reasons. */
export type RejectedCandidate = SeedRejected['rejected'][number];

/** One reason a candidate was rejected. */
export type RejectionReason = RejectedCandidate['reasons'][number];
