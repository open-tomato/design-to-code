/**
 * The script path's design-system manifest: every `_ds_manifest.json` that
 * discovery found, read leniently, and its entries merged with the marker
 * candidates by name.
 *
 * {@link readDsManifests} reads each found file in `knownFiles` order. A
 * file must be JSON holding a `components` list; any other key is ignored.
 * A file that is not JSON, or whose `components` is missing or not a list,
 * throws a {@link DsManifestError} naming its path. A file is filled when
 * its `components` list is not empty; {@link hasFilledDsManifest} says
 * whether any is.
 *
 * {@link mergeDsManifests} reads each entry leniently: it needs a `name`;
 * `level`, `description`, `variants`, `page` and `selector` are optional,
 * `null` counts as absent, and unknown keys are ignored. An entry that
 * fails that shape, or gives only one of `page` and `selector`, is
 * rejected as `invalid-shape`, and one repeating a name an earlier entry
 * listed (files by path, entries in file order) as `duplicate-name`. Then:
 *
 * - An entry with `page` and `selector` is used as written: its own
 *   fields, no examples, states or parts.
 * - One without is located by the `data-component="<name>"` roots the
 *   marker reader found on kept pages, a candidate or a `missing-level`
 *   rejection, taking the one on the first page by path. Its fields win
 *   over the marker fields: `level`, `variants` (becomes `variantAxes`,
 *   each list sorted and unique) and `description` (trimmed, becomes the
 *   one paragraph of `docText`); the root's `page`, `selector`,
 *   `examples`, `states` and `parts` are kept.
 * - One located nowhere is rejected as `unlocated`.
 *
 * Every entry the merge produces carries `origin: 'manifest'`. One left
 * with no valid level is rejected as `missing-level`, and one failing the
 * entry schema as `invalid-shape`. The marker candidates and `missing-level`
 * rejections of every name a manifest entry claims, on any page, are
 * replaced by the merge's result for that entry; the rest pass through.
 *
 * @packageDocumentation
 */

import type { MarkedComponents } from './markers.ts';
import type { ComponentEntry, RejectedCandidate } from './schema.ts';
import type { KnownFile } from '../assess/schema.ts';

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { relativePath } from '../assess/schema.ts';
import { sourceDirFile } from '../serve/serve-record.ts';

import { COMPONENT_ATTRIBUTE } from './markers.ts';
import { componentEntrySchema, LEVELS } from './schema.ts';

/** The design-system manifest's file name, as `knownFiles` lists it. */
export const DS_MANIFEST_FILE = '_ds_manifest.json';

/** A JSON value, as a rejected candidate keeps it. */
type Json = RejectedCandidate['candidate'];

/** A `_ds_manifest.json` that could not be read, is not JSON or has no `components` list. */
export class DsManifestError extends Error {
  override readonly name = 'DsManifestError';

  /** The absolute path of the file refused. */
  readonly path: string;

  /** Builds the error for the file at `path`, saying why in `reason`. */
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.path = path;
  }
}

/** One found `_ds_manifest.json`, read leniently. */
export interface DsManifest {
  /** The file's path relative to the source dir, as `knownFiles` lists it. */
  readonly path: string;
  /** True when `components` is not empty. */
  readonly filled: boolean;
  /** The `components` entries as written, each checked only by the merge. */
  readonly components: readonly Json[];
}

/** The marker candidates with the manifest entries merged in, and every rejection. */
export interface MergedCandidates {
  readonly candidates: readonly ComponentEntry[];
  readonly rejected: readonly RejectedCandidate[];
}

/** What a design-system manifest file must hold; any other key is ignored. */
const dsManifestFileSchema = z.looseObject({
  components: z.array(z.json()),
});

/** True when a lenient optional field holds a value: neither absent nor `null`. */
function isGiven<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

/** One design-system manifest entry, read leniently: `null` is absent, unknown keys are ignored. */
const dsManifestEntrySchema = z
  .looseObject({
    name: z.string().min(1),
    level: z.enum(LEVELS).nullish(),
    description: z.string().nullish(),
    variants: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).nullish(),
    page: relativePath.nullish(),
    selector: z.string().min(1)
      .nullish(),
  })
  .refine((entry) => isGiven(entry.page) === isGiven(entry.selector), {
    error: 'page and selector must be given together',
  });

/** One design-system manifest entry, as {@link dsManifestEntrySchema} reads it. */
type DsManifestEntry = z.infer<typeof dsManifestEntrySchema>;

/** A `data-component` root the marker reader found and read as a `missing-level` rejection. */
const levellessRootSchema = componentEntrySchema.extend({ level: z.unknown().optional() });

/** A `data-component` root the marker reader found, with a level or without a valid one. */
type LocatedRoot = z.infer<typeof levellessRootSchema>;

/**
 * Reads every `_ds_manifest.json` that `knownFiles` lists as found, in
 * path order, per this module's documentation.
 *
 * @param sourceDir - The project's source dir the paths are relative to.
 * @param knownFiles - The discovery report's `knownFiles`.
 * @returns One {@link DsManifest} per found file; none when it is absent.
 * @throws DsManifestError naming the path when a file cannot be read, is
 * not JSON, or has no `components` list.
 */
export function readDsManifests(sourceDir: string, knownFiles: readonly KnownFile[]): readonly DsManifest[] {
  const paths = knownFiles.find((file) => file.name === DS_MANIFEST_FILE)?.paths ?? [];

  return paths.map((path) => readDsManifest(sourceDir, path));
}

/** Reads the manifest at `path` under `sourceDir`. */
function readDsManifest(sourceDir: string, path: string): DsManifest {
  const absolute = sourceDirFile(sourceDir, path);
  let written: unknown;

  try {
    written = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new DsManifestError(absolute, `cannot be read as JSON (${(error as Error).message})`);
  }

  const parsed = dsManifestFileSchema.safeParse(written);

  if (!parsed.success) {
    throw new DsManifestError(absolute, '`components` is not a list');
  }

  return { path, filled: parsed.data.components.length > 0, components: parsed.data.components };
}

/** True when at least one of `manifests` is filled. */
export function hasFilledDsManifest(manifests: readonly DsManifest[]): boolean {
  return manifests.some((manifest) => manifest.filled);
}

/** One manifest entry with the file it came from. */
interface SourcedEntry {
  readonly source: string;
  readonly raw: Json;
}

/** One rejection with a single reason. */
function rejection(candidate: Json, code: RejectedCandidate['reasons'][number]['code'], detail: string): RejectedCandidate {
  return { candidate, reasons: [{ code, detail }] };
}

/** True when `value` is one of {@link LEVELS}. */
function isLevel(value: unknown): boolean {
  return LEVELS.some((level) => level === value);
}

/** Orders two paths by code unit. */
function comparePaths(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right
    ? -1
    : 1;
}

/**
 * The marker roots by name: each name's root on the first page by path,
 * read from the candidates and the `missing-level` rejections.
 */
function locateRoots(markers: MarkedComponents): ReadonlyMap<string, LocatedRoot> {
  const levelless = markers.rejected
    .filter((rejected) => rejected.reasons.some((reason) => reason.code === 'missing-level'))
    .flatMap((rejected) => {
      const parsed = levellessRootSchema.safeParse(rejected.candidate);

      return parsed.success
        ? [parsed.data]
        : [];
    });
  const roots: LocatedRoot[] = [...markers.candidates, ...levelless];
  const byPage = [...roots].sort((left, right) => comparePaths(left.page, right.page));

  return byPage.reduce((located, root) => (located.has(root.name)
    ? located
    : new Map([...located, [root.name, root]])), new Map<string, LocatedRoot>());
}

/** The proposal for `entry`, from its own placement or from `root`. */
function proposalOf(entry: DsManifestEntry, root: LocatedRoot | undefined): Record<string, unknown> {
  const description = entry.description?.trim() ?? '';
  const own = {
    ...isGiven(entry.level)
      ? { level: entry.level }
      : {},
    ...isGiven(entry.variants)
      ? { variantAxes: sortedVariants(entry.variants) }
      : {},
    ...description === ''
      ? {}
      : { docText: [description] },
  };
  const base = root ?? {
    name: entry.name,
    page: entry.page,
    selector: entry.selector,
    examples: [],
    states: [],
    variantAxes: {},
    parts: [],
    docText: [],
  };

  return { ...base, ...own, name: entry.name, origin: 'manifest' };
}

/** `variants` with each value list sorted by code unit and unique. */
function sortedVariants(variants: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(variants).map(([axis, values]) => [axis, [...new Set(values)].sort()]));
}

/** Judges one parsed entry: the merged entry, or its rejection. */
function judgeEntry(entry: DsManifestEntry, source: string, raw: Json, roots: ReadonlyMap<string, LocatedRoot>): ComponentEntry | RejectedCandidate {
  const explicit = isGiven(entry.page);
  const root = explicit
    ? undefined
    : roots.get(entry.name);
  const where = `the "${entry.name}" entry of ${source}`;

  if (!explicit && root === undefined) {
    return rejection(raw, 'unlocated', `${where} gives no page and selector, and no kept page has a ${COMPONENT_ATTRIBUTE}="${entry.name}" root`);
  }

  const proposal = proposalOf(entry, root);

  if (!isLevel(proposal.level)) {
    return rejection(proposal as Json, 'missing-level', root === undefined
      ? `${where} gives no level`
      : `${where} gives no level, and its root ${root.selector} on ${root.page} has no valid data-level`);
  }

  const parsed = componentEntrySchema.safeParse(proposal);

  return parsed.success
    ? parsed.data
    : rejection(proposal as Json, 'invalid-shape', `${where}: ${z.prettifyError(parsed.error)}`);
}

/** True when `result` is a rejection rather than an entry. */
function isRejection(result: ComponentEntry | RejectedCandidate): result is RejectedCandidate {
  return 'reasons' in result;
}

/** The accumulator of {@link mergeDsManifests}: results so far and the names claimed. */
interface MergeState {
  readonly results: readonly (ComponentEntry | RejectedCandidate)[];
  readonly claimed: ReadonlyMap<string, string>;
}

/** Folds one sourced entry into `state`. */
function mergeEntry(state: MergeState, sourced: SourcedEntry, roots: ReadonlyMap<string, LocatedRoot>): MergeState {
  const parsed = dsManifestEntrySchema.safeParse(sourced.raw);

  if (!parsed.success) {
    const detail = `an entry of ${sourced.source}: ${z.prettifyError(parsed.error)}`;

    return { ...state, results: [...state.results, rejection(sourced.raw, 'invalid-shape', detail)] };
  }

  const { name } = parsed.data;
  const firstSource = state.claimed.get(name);

  if (firstSource !== undefined) {
    const detail = `the "${name}" entry of ${sourced.source} repeats a name ${firstSource} already lists`;

    return { ...state, results: [...state.results, rejection(sourced.raw, 'duplicate-name', detail)] };
  }

  return {
    results: [...state.results, judgeEntry(parsed.data, sourced.source, sourced.raw, roots)],
    claimed: new Map([...state.claimed, [name, sourced.source]]),
  };
}

/** True when `rejected` is a `missing-level` marker rejection of a name in `claimed`. */
function isClaimedLevelless(rejected: RejectedCandidate, claimed: ReadonlyMap<string, string>): boolean {
  const parsed = levellessRootSchema.safeParse(rejected.candidate);

  return parsed.success
    && claimed.has(parsed.data.name)
    && rejected.reasons.some((reason) => reason.code === 'missing-level');
}

/**
 * Merges the entries of `manifests` with the marker candidates `markers`
 * by name, per this module's documentation.
 *
 * @param manifests - The manifests {@link readDsManifests} read.
 * @param markers - The marker reads of every marked kept page, combined.
 * @returns The unclaimed marker candidates followed by the merged entries
 * in manifest order, and the unclaimed marker rejections followed by the
 * manifest rejections in manifest order.
 */
export function mergeDsManifests(manifests: readonly DsManifest[], markers: MarkedComponents): MergedCandidates {
  const roots = locateRoots(markers);
  const entries = manifests.flatMap((manifest) => manifest.components.map((raw) => ({ source: manifest.path, raw })));
  const { results, claimed } = entries.reduce(
    (state: MergeState, sourced) => mergeEntry(state, sourced, roots),
    { results: [], claimed: new Map() },
  );

  return {
    candidates: [
      ...markers.candidates.filter((candidate) => !claimed.has(candidate.name)),
      ...results.filter((result): result is ComponentEntry => !isRejection(result)),
    ],
    rejected: [
      ...markers.rejected.filter((rejected) => !isClaimedLevelless(rejected, claimed)),
      ...results.filter(isRejection),
    ],
  };
}
