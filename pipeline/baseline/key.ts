/**
 * Baseline storage keys: where a baseline for one import, captured with one
 * Playwright version, lives on disk.
 *
 * The key directory is `<baselineDir>/<playwright version>/<import hash>/`.
 * The Playwright version is the `version` of the installed `playwright-core`
 * package, read through `createRequire`, so upgrading Playwright never
 * compares against screenshots its older renderer took. The import hash is
 * the SHA-256 hex of the bytes of `<source.dir>/.import/record.json` as
 * written, so any re-import, whose `importedAt` always changes, lands under
 * a new key.
 *
 * Under the key, each captured page and viewport is a PNG at
 * `pages/<page path>/<viewport name>.png`. Every path built here is
 * resolved and then checked with `relative()` against the directory it
 * must stay inside; one that escapes is a {@link BaselinePathError}.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { recordPath } from '../import/record.ts';

/** The command that writes the import record a baseline is keyed on. */
export const IMPORT_COMMAND = 'bun run d2c import';

/** The directory, under the key directory, that holds the page PNGs. */
export const PAGES_DIR = 'pages';

/** The extension of a captured page-viewport screenshot. */
export const PNG_EXTENSION = '.png';

/** The package whose `version` names the renderer a baseline was taken with. */
const PLAYWRIGHT_PACKAGE = 'playwright-core/package.json';

/** No import record in the source dir, so there is nothing to key on. */
export class MissingImportRecordError extends Error {
  override readonly name = 'MissingImportRecordError';
}

/** A baseline path that would land outside the directory it belongs in. */
export class BaselinePathError extends Error {
  override readonly name = 'BaselinePathError';
}

/** What {@link keyDirectory} builds the key directory from. */
export interface KeyDirectoryOptions {
  /** The config's `baselineDir`, relative to `rootDir` or absolute. */
  readonly baselineDir: string;
  /** The directory a relative `baselineDir` resolves against. */
  readonly rootDir: string;
  /** The installed Playwright version, from {@link readPlaywrightVersion}. */
  readonly playwrightVersion: string;
  /** The import hash, from {@link readImportHash}. */
  readonly importHash: string;
}

/** Whether `candidate` lies strictly below `root`. */
function isStrictlyInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);

  return fromRoot !== ''
    && !isAbsolute(fromRoot)
    && fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`);
}

/** Resolves `segments` under `root`, refusing a result outside it. */
function containedPath(root: string, label: string, ...segments: readonly string[]): string {
  if (segments.some((segment) => segment.includes('\0'))) {
    throw new BaselinePathError(`${label} holds a NUL byte`);
  }

  const target = resolve(root, ...segments);

  if (segments.some(isAbsolute) || !isStrictlyInside(root, target)) {
    throw new BaselinePathError(`${label} does not resolve inside ${root}`);
  }

  return target;
}

/**
 * Reads the `version` of the installed `playwright-core` package.
 *
 * @throws Error when the package cannot be resolved or carries no version.
 */
export function readPlaywrightVersion(): string {
  const manifest: unknown = createRequire(import.meta.url)(PLAYWRIGHT_PACKAGE);
  const version = typeof manifest === 'object' && manifest !== null && 'version' in manifest
    ? manifest.version
    : undefined;

  if (typeof version !== 'string' || version === '') {
    throw new Error(`${PLAYWRIGHT_PACKAGE} has no version`);
  }

  return version;
}

/**
 * Hashes `<sourceDir>/.import/record.json` byte for byte with SHA-256.
 *
 * @returns The digest as lowercase hex.
 * @throws MissingImportRecordError when the record does not exist; its
 * message names {@link IMPORT_COMMAND}. Any other read failure is rethrown.
 */
export function readImportHash(sourceDir: string): string {
  const target = recordPath(sourceDir);
  let bytes: Buffer;

  try {
    bytes = readFileSync(target);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new MissingImportRecordError(
        `no import record at ${target}; run \`${IMPORT_COMMAND}\` first`,
        { cause: error },
      );
    }

    throw error;
  }

  return createHash('sha256')
    .update(bytes)
    .digest('hex');
}

/**
 * Builds `<baselineDir>/<playwright version>/<import hash>` as an absolute
 * path, `baselineDir` resolved against `rootDir` unless it is absolute.
 *
 * @throws BaselinePathError when the version or the hash would not make a
 * directory strictly inside the baseline dir, one level per segment.
 */
export function keyDirectory(options: KeyDirectoryOptions): string {
  const { baselineDir, rootDir, playwrightVersion, importHash } = options;
  const root = resolve(rootDir, baselineDir);
  const versionDir = containedPath(root, `Playwright version "${playwrightVersion}"`, playwrightVersion);

  if (dirname(versionDir) !== root) {
    throw new BaselinePathError(`Playwright version "${playwrightVersion}" is not one path segment`);
  }

  const key = containedPath(versionDir, `import hash "${importHash}"`, importHash);

  if (dirname(key) !== versionDir) {
    throw new BaselinePathError(`import hash "${importHash}" is not one path segment`);
  }

  return key;
}

/**
 * Builds `<keyDir>/pages/<page path>/<viewport name>.png`.
 *
 * `pagePath` is POSIX-relative to the source dir, as discovery lists it,
 * and may hold spaces and folders.
 *
 * @throws BaselinePathError when the page path is absolute or resolves
 * outside `<keyDir>/pages` (or onto it), or when the viewport name is not
 * one path segment.
 */
export function pagePngPath(keyDir: string, pagePath: string, viewportName: string): string {
  const pagesRoot = resolve(keyDir, PAGES_DIR);
  const pageDir = containedPath(pagesRoot, `page path "${pagePath}"`, pagePath);
  const png = containedPath(pageDir, `viewport name "${viewportName}"`, `${viewportName}${PNG_EXTENSION}`);

  if (dirname(png) !== pageDir) {
    throw new BaselinePathError(`viewport name "${viewportName}" is not one path segment`);
  }

  return png;
}
