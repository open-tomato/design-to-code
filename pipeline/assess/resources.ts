/**
 * Resource discovery: the token files, variant maps, asset groups and
 * known files of an export.
 *
 * Every function here takes the source dir's file list as
 * {@link walkSourceDir} gives it (POSIX paths relative to the source dir)
 * and returns lists sorted by path, code unit by code unit, so the same
 * export always gives the same result.
 *
 * - Token files ({@link discoverTokens}) — every `tokens.*` file by name,
 *   plus every `.css` file declaring at least one CSS custom property, each
 *   with the number of distinct custom properties it declares.
 * - Variant maps ({@link discoverVariantMaps}) — every `variants.*` file by
 *   name.
 * - Asset groups ({@link groupAssets}) — every file, sorted by extension
 *   into one of {@link ASSET_GROUPS}.
 * - Known files ({@link discoverKnownFiles}) — each of
 *   {@link KNOWN_FILE_NAMES}, looked for at any depth and marked found or
 *   absent. None is required.
 *
 * Names and extensions match without regard to case, except known file
 * names, which match exactly as Claude Design writes them.
 *
 * @packageDocumentation
 */

import type { Assets, KnownFile, TokenFile, VariantMap } from './schema.ts';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ASSET_GROUPS, KNOWN_FILE_NAMES } from './schema.ts';
import { comparePaths } from './walk.ts';

type AssetGroup = (typeof ASSET_GROUPS)[number];

/** The file-name prefix, matched without regard to case, of a token file. */
const TOKENS_PREFIX = 'tokens.';

/** The file-name prefix, matched without regard to case, of a variant map. */
const VARIANTS_PREFIX = 'variants.';

/** The extension of a stylesheet whose custom properties are counted. */
const CSS_EXTENSION = 'css';

/** The extensions of each asset group but `other`, which takes the rest. */
const GROUP_EXTENSIONS: Readonly<Record<Exclude<AssetGroup, 'other'>, readonly string[]>> = {
  images: ['apng', 'avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp'],
  fonts: ['eot', 'otf', 'ttc', 'ttf', 'woff', 'woff2'],
  styles: ['css', 'less', 'sass', 'scss'],
  scripts: ['cjs', 'cts', 'js', 'jsx', 'mjs', 'mts', 'ts', 'tsx'],
};

/** CSS comments and quoted strings, which never declare a property. */
const CSS_COMMENT_OR_STRING = /\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/g;

/**
 * A custom property declaration: `--name` at the start of a declaration,
 * then `:`. A `var(--name)` reference has no `:` after the name and a
 * `.block--modifier:hover` selector has no declaration start before it,
 * so neither matches.
 */
const CUSTOM_PROPERTY_DECLARATION = /(?:^|[{;\s])(--[\w\u0080-￿-]+)\s*:/g;

/** The file name: the last segment of a POSIX path. */
function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The extension after a file name's last `.`, lower-cased; empty if none. */
function extensionOf(path: string): string {
  const baseName = baseNameOf(path);
  const dot = baseName.lastIndexOf('.');

  return dot <= 0
    ? ''
    : baseName.slice(dot + 1).toLowerCase();
}

function hasNamePrefix(path: string, prefix: string): boolean {
  return baseNameOf(path)
    .toLowerCase()
    .startsWith(prefix);
}

function sortedPaths(paths: readonly string[]): string[] {
  return [...paths].sort(comparePaths);
}

/**
 * Counts the distinct CSS custom properties `css` declares. A property
 * declared again, under another selector or theme, counts once. Comments,
 * quoted strings and `var()` references are not declarations.
 *
 * @param css - A stylesheet's text.
 */
export function countCustomProperties(css: string): number {
  const declarations = css.replace(CSS_COMMENT_OR_STRING, ' ');
  const names = [...declarations.matchAll(CUSTOM_PROPERTY_DECLARATION)].map((match) => match[1]);

  return new Set(names).size;
}

/**
 * Lists the token files among `paths`, sorted by path.
 *
 * A token file is a `tokens.*` file, whatever its extension, or a `.css`
 * file that declares at least one custom property. A `.css` file only
 * reading properties through `var()` is not one. `customPropertyCount` is
 * {@link countCustomProperties} for a `.css` file and 0 for any other.
 *
 * @param sourceDir - The directory `paths` are relative to; `.css` files
 * are read from it.
 * @param paths - POSIX paths relative to `sourceDir`.
 */
export function discoverTokens(sourceDir: string, paths: readonly string[]): TokenFile[] {
  return sortedPaths(paths).flatMap((path) => {
    const customPropertyCount = extensionOf(path) === CSS_EXTENSION
      ? countCustomProperties(readFileSync(join(sourceDir, ...path.split('/')), 'utf8'))
      : 0;

    return hasNamePrefix(path, TOKENS_PREFIX) || customPropertyCount > 0
      ? [{ path, customPropertyCount }]
      : [];
  });
}

/**
 * Lists the variant maps among `paths`: every `variants.*` file, whatever
 * its extension, sorted by path.
 *
 * @param paths - POSIX paths relative to the source dir.
 */
export function discoverVariantMaps(paths: readonly string[]): VariantMap[] {
  return sortedPaths(paths)
    .filter((path) => hasNamePrefix(path, VARIANTS_PREFIX))
    .map((path) => ({ path }));
}

/** The group a path's extension puts it in; `other` when none claims it. */
export function assetGroupOf(path: string): AssetGroup {
  const extension = extensionOf(path);
  const group = ASSET_GROUPS.find((name) => name !== 'other' && GROUP_EXTENSIONS[name].includes(extension));

  return group ?? 'other';
}

/**
 * Sorts every path into exactly one of {@link ASSET_GROUPS} by its
 * extension ({@link assetGroupOf}); each group is sorted by path. Pages and
 * any file no group claims land in `other`.
 *
 * @param paths - POSIX paths relative to the source dir.
 */
export function groupAssets(paths: readonly string[]): Assets {
  const sorted = sortedPaths(paths);
  const pathsIn = (group: AssetGroup): string[] => sorted.filter((path) => assetGroupOf(path) === group);

  return {
    images: pathsIn('images'),
    fonts: pathsIn('fonts'),
    styles: pathsIn('styles'),
    scripts: pathsIn('scripts'),
    other: pathsIn('other'),
  };
}

/**
 * Looks for each of {@link KNOWN_FILE_NAMES} at any depth, in that order.
 * A name is `found`, with every path it sits at sorted, when its exact file
 * name occurs in `paths`, and `absent`, with no paths, when it does not.
 *
 * @param paths - POSIX paths relative to the source dir.
 */
export function discoverKnownFiles(paths: readonly string[]): KnownFile[] {
  const sorted = sortedPaths(paths);

  return KNOWN_FILE_NAMES.map((name) => {
    const found = sorted.filter((path) => baseNameOf(path) === name);

    return {
      name,
      status: found.length > 0
        ? 'found'
        : 'absent',
      paths: found,
    };
  });
}
