/**
 * The project-config schema: one `projects/<slug>.json` per extraction
 * project, validated with zod.
 *
 * Required fields are `slug` and `source.dir`. Every other field is either
 * optional or has a default, and the defaults that depend on the slug
 * (`name`, `target.dir`, `baselineDir`) are filled in by a transform after
 * the input has parsed, so a parsed config always carries them. Paths are
 * relative to the repo root.
 *
 * The TypeScript type of a parsed config is {@link ProjectConfig}, inferred
 * from the schema; it is never written by hand.
 *
 * @packageDocumentation
 */

import { z } from 'zod';

/**
 * A slug is lowercase ASCII letters and digits in hyphen-separated runs. It
 * names the config file and seeds the default paths, so it may not hold a
 * path separator or a dot. The loader checks `D2C_PROJECT` against it
 * before building the file path.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The kinds of package an extraction can target. */
export const TARGET_KINDS = ['component-library'] as const;

/**
 * How a library gets its Storybook: `managed` uses the shared harness,
 * `detached` means the library ships its own. The schema accepts both; the
 * loader refuses `detached` until it is supported.
 */
export const STORYBOOK_MODES = ['managed', 'detached'] as const;

const nonEmptyString = z.string().min(1);

const nonEmptyStringList = z.array(nonEmptyString);

const viewportSchema = z.object({
  name: nonEmptyString,
  width: z.int().positive(),
  height: z.int().positive(),
});

// `prefault({})` parses a missing object as `{}`, so an absent `source`
// reports its missing `dir` at `source.dir`, and an absent `target` or
// `storybook` still gains its defaults. The prefault's type asks for a
// valid input, which `{}` is not for `source`; the cast is what lets the
// parse fail on the field rather than on its parent.
const sourceSchema = z
  .object({
    dir: nonEmptyString,
    shareLink: z.url().optional(),
  })
  .prefault({} as { dir: string });

const targetSchema = z
  .object({
    dir: nonEmptyString.optional(),
    kind: z.enum(TARGET_KINDS).default('component-library'),
  })
  .prefault({});

const storybookSchema = z
  .object({
    mode: z.enum(STORYBOOK_MODES).default('managed'),
  })
  .prefault({});

/**
 * The default level folders of a component library, lowest first: the
 * folders under `<target.dir>/src/` a component may live in.
 */
export const DEFAULT_LEVELS = [
  'particles',
  'atoms',
  'molecules',
  'organisms',
  'templates',
  'layouts',
] as const;

const levelsSchema = z
  .array(nonEmptyString)
  .min(1)
  .refine((levels) => new Set(levels).size === levels.length, {
    error: 'must not repeat a level',
  })
  .default([...DEFAULT_LEVELS]);

const pagesSchema = z.object({
  keep: nonEmptyStringList.optional(),
  discard: nonEmptyStringList.optional(),
});

const toleranceSchema = z.object({
  designVsCode: z
    .number()
    .min(0)
    .max(1)
    .optional(),
});

/**
 * Validates a project config and fills in its defaults.
 *
 * - `slug` — required; lowercase letters and digits in hyphen-separated runs.
 * - `name` — defaults to the slug.
 * - `source.dir` — required; the design export's directory.
 * - `source.shareLink` — optional URL the export was shared from.
 * - `target.dir` — defaults to `components/<slug>`.
 * - `target.kind` — defaults to `component-library`, its only value so far.
 * - `baselineDir` — defaults to `baselines/<slug>`.
 * - `storybook.mode` — `managed` (the default) or `detached`.
 * - `levels` — the library's level folder names, lowest first; a non-empty
 *   list without repeats, defaulting to {@link DEFAULT_LEVELS}.
 * - `pages.keep`, `pages.discard` — optional lists of page names.
 * - `viewports` — optional list of `{ name, width, height }`, sizes in
 *   whole pixels.
 * - `tolerance.designVsCode` — optional share of differing pixels allowed
 *   between the design and the code, from 0 to 1.
 *
 * Each issue of a failed parse carries the failing field's path, so
 * `issue.path.join('.')` names it as `source.dir`. Unknown keys are
 * stripped.
 */
export const projectConfigSchema = z
  .object({
    slug: z.string().regex(SLUG_PATTERN, {
      error: 'must be lowercase letters and digits in hyphen-separated runs',
    }),
    name: nonEmptyString.optional(),
    source: sourceSchema,
    target: targetSchema,
    baselineDir: nonEmptyString.optional(),
    storybook: storybookSchema,
    levels: levelsSchema,
    pages: pagesSchema.optional(),
    viewports: z
      .array(viewportSchema)
      .min(1)
      .optional(),
    tolerance: toleranceSchema.optional(),
  })
  .transform(({ slug, name, target, baselineDir, ...rest }) => ({
    ...rest,
    slug,
    name: name ?? slug,
    target: {
      ...target,
      dir: target.dir ?? `components/${slug}`,
    },
    baselineDir: baselineDir ?? `baselines/${slug}`,
  }));

/** A parsed project config, with every default filled in. */
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

/** A project config as written in `projects/<slug>.json`, before defaults. */
export type ProjectConfigInput = z.input<typeof projectConfigSchema>;
