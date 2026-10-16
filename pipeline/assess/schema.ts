/**
 * The discovery report: `discovery.json` in a project's source dir, which
 * says what a design export actually holds.
 *
 * The report has two owners. The deterministic discovery scripts own the
 * fields named in {@link SCRIPT_FIELDS} (`pages`, `tokens`, `variantMaps`,
 * `assets`, `knownFiles`) plus the `generatedAt` stamp, and are validated
 * by {@link scriptReportSchema}. The assess agent owns `agentNotes` alone,
 * validated by {@link agentNotesSchema}. {@link discoveryReportSchema} is
 * the whole file: the script report extended by `agentNotes`.
 *
 * Every object is strict, so an unknown key fails the parse instead of
 * being stripped. Paths are POSIX-relative to the source dir. Path-keyed
 * lists must be sorted by path, code unit by code unit, with no duplicates,
 * and a page's marker names must be sorted, so the same export always
 * serializes to the same bytes apart from `generatedAt`. A page's scripts
 * and stylesheets are the exception: they keep document order.
 *
 * The TypeScript types are inferred from the schemas, never written by hand.
 *
 * @packageDocumentation
 */

import { z } from 'zod';

/**
 * The top-level report fields that only the discovery scripts write. The
 * merge of agent output refuses any output that touches one of them.
 */
export const SCRIPT_FIELDS = ['pages', 'tokens', 'variantMaps', 'assets', 'knownFiles'] as const;

/**
 * The files discovery looks for at any depth, sorted by code unit. None is
 * required: each is reported as found or absent.
 */
export const KNOWN_FILE_NAMES = [
  '_adherence.oxlintrc.json',
  '_ds_manifest.json',
  'support.js',
  'tokens.ts',
  'variants.ts',
] as const;

/** Whether a known file was found in the export. */
export const KNOWN_FILE_STATUSES = ['found', 'absent'] as const;

/** The groups `assets` sorts every file into, by kind. */
export const ASSET_GROUPS = ['images', 'fonts', 'styles', 'scripts', 'other'] as const;

/** What the agent can say a page is. */
export const PAGE_ROLES = ['early-version', 'demo', 'breakdown', 'other'] as const;

/** A `data-*` attribute name, as a page's `markers` keys it. */
const MARKER_NAME_PATTERN = /^data-.+$/;

const nonEmptyString = z.string().min(1);

const count = z.int().min(0);

/** True when `values` is strictly ascending by code unit: sorted, unique. */
function isStrictlyAscending(values: readonly string[]): boolean {
  return values.every((value, index) => {
    const previous = values[index - 1];

    return previous === undefined || previous < value;
  });
}

const SORTED_ERROR = 'must be sorted by code unit with no duplicates';

/**
 * A path POSIX-relative to the source dir: no leading `/`, no backslash,
 * no empty, `.` or `..` segment.
 */
// The empty path fails on its lone empty segment, so it reports one issue.
export const relativePath = z.string().refine(
  (path) => !path.startsWith('/')
    && !path.includes('\\')
    && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
  { error: 'must be a POSIX path relative to the source dir' },
);

const sortedPathList = z
  .array(relativePath)
  .refine(isStrictlyAscending, { error: SORTED_ERROR });

/** A list of `{ path }` objects that must be sorted by path, unique. */
export function sortedByPath<T extends z.ZodType<{ path: string }>>(item: T) {
  return z
    .array(item)
    .refine((items) => isStrictlyAscending(items.map((entry) => entry.path)), { error: SORTED_ERROR });
}

const scriptSchema = z.union([
  z.strictObject({ src: nonEmptyString, type: z.string().nullable() }),
  z.strictObject({ inline: z.literal(true), type: z.string().nullable() }),
]);

const stylesheetSchema = z.union([
  z.strictObject({ href: nonEmptyString }),
  z.strictObject({ inline: z.literal(true) }),
]);

const markersSchema = z
  .record(z.string().regex(MARKER_NAME_PATTERN, { error: 'must be a data-* attribute name' }), count)
  .refine((markers) => isStrictlyAscending(Object.keys(markers)), { error: SORTED_ERROR });

/**
 * One HTML page. `scripts` and `stylesheets` keep document order; `title`
 * is null when the page has no `<title>`; `markers` counts each `data-*`
 * attribute name, keys sorted.
 */
const pageSchema = z.strictObject({
  path: relativePath,
  title: z.string().nullable(),
  scripts: z.array(scriptSchema),
  stylesheets: z.array(stylesheetSchema),
  markers: markersSchema,
});

const tokenFileSchema = z.strictObject({
  path: relativePath,
  customPropertyCount: count,
});

const variantMapSchema = z.strictObject({
  path: relativePath,
});

const assetsSchema = z.strictObject({
  images: sortedPathList,
  fonts: sortedPathList,
  styles: sortedPathList,
  scripts: sortedPathList,
  other: sortedPathList,
});

const knownFileSchema = z
  .strictObject({
    name: z.enum(KNOWN_FILE_NAMES),
    status: z.enum(KNOWN_FILE_STATUSES),
    paths: sortedPathList,
  })
  .refine((file) => (file.status === 'found') === (file.paths.length > 0), {
    error: 'status must be found exactly when paths is non-empty',
    path: ['status'],
  });

const knownFilesSchema = z
  .array(knownFileSchema)
  .refine(
    (files) => files.length === KNOWN_FILE_NAMES.length
      && files.every((file, index) => file.name === KNOWN_FILE_NAMES[index]),
    { error: `must list each known file once, in the order ${KNOWN_FILE_NAMES.join(', ')}` },
  );

/**
 * Validates the fields the discovery scripts own.
 *
 * - `generatedAt` — an ISO 8601 date-time; the only field allowed to differ
 *   between two runs over the same export.
 * - `pages` — every `.html` file, sorted by path.
 * - `tokens` — `tokens.*` files and CSS files declaring custom properties,
 *   each with its `customPropertyCount`, sorted by path.
 * - `variantMaps` — `variants.*` files, sorted by path.
 * - `assets` — every file path, sorted, in one of {@link ASSET_GROUPS}.
 * - `knownFiles` — one `{ name, status, paths }` per
 *   {@link KNOWN_FILE_NAMES} entry, in that order; `found` exactly when
 *   `paths` is non-empty.
 */
export const scriptReportSchema = z.strictObject({
  generatedAt: z.iso.datetime(),
  pages: sortedByPath(pageSchema),
  tokens: sortedByPath(tokenFileSchema),
  variantMaps: sortedByPath(variantMapSchema),
  assets: assetsSchema,
  knownFiles: knownFilesSchema,
});

const pageRoleSchema = z.strictObject({
  role: z.enum(PAGE_ROLES),
  reason: nonEmptyString,
});

const boundaryHintSchema = z.union([
  z.strictObject({ page: relativePath, selector: nonEmptyString, note: nonEmptyString }),
  z.strictObject({ page: relativePath, marker: nonEmptyString, note: nonEmptyString }),
]);

/**
 * Validates the only field the assess agent writes.
 *
 * - `pageRoles` — page path to `{ role, reason }`, role one of
 *   {@link PAGE_ROLES}.
 * - `versionGroups` — lists of page paths that are versions of one page,
 *   each list holding at least two.
 * - `boundaryHints` — `{ page, selector | marker, note }` where a component
 *   boundary looks marked.
 */
export const agentNotesSchema = z.strictObject({
  pageRoles: z.record(relativePath, pageRoleSchema),
  versionGroups: z.array(z.array(relativePath).min(2)),
  boundaryHints: z.array(boundaryHintSchema),
});

/** Validates a whole `discovery.json`: the script report plus `agentNotes`. */
export const discoveryReportSchema = scriptReportSchema.extend({
  agentNotes: agentNotesSchema,
});

/** The fields the discovery scripts own, parsed. */
export type ScriptReport = z.infer<typeof scriptReportSchema>;

/** The assess agent's notes, parsed. */
export type AgentNotes = z.infer<typeof agentNotesSchema>;

/** A parsed `discovery.json`. */
export type DiscoveryReport = z.infer<typeof discoveryReportSchema>;

/** One discovered HTML page. */
export type Page = ScriptReport['pages'][number];

/** One script a page loads, by `src` or inline. */
export type PageScript = Page['scripts'][number];

/** One stylesheet a page loads, by `href` or inline. */
export type PageStylesheet = Page['stylesheets'][number];

/** One token file. */
export type TokenFile = ScriptReport['tokens'][number];

/** One variant map. */
export type VariantMap = ScriptReport['variantMaps'][number];

/** Every file path, grouped by kind. */
export type Assets = ScriptReport['assets'];

/** One known file's found-or-absent reading. */
export type KnownFile = ScriptReport['knownFiles'][number];

/** The name of a script-owned top-level field. */
export type ScriptField = (typeof SCRIPT_FIELDS)[number];

/**
 * The `agentNotes` a report carries before the agent has run: no roles, no
 * groups, no hints. Returns a fresh object on every call.
 */
export function emptyAgentNotes(): AgentNotes {
  return { pageRoles: {}, versionGroups: [], boundaryHints: [] };
}
