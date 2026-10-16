/**
 * The import record: `.import/record.json` in a project's source dir, which
 * says where the files came from, when they arrived, and the SHA-256 hash of
 * each one.
 *
 * The record is validated by {@link importRecordSchema}. Its `files` list
 * holds one entry per regular file under the source dir, paths POSIX-relative
 * to it and sorted, with the `.import/` directory itself left out so the
 * record never hashes itself. Its `dropped` list names the archive entries a
 * zip import left out on purpose, macOS metadata and `.DS_Store` files.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { z } from 'zod';

/**
 * Where an import came from. Only `folder` and `zip` are produced so far;
 * `share-link` and `send-to-claude` are named for the sources a later
 * import adds.
 */
export const IMPORT_KINDS = ['folder', 'zip', 'share-link', 'send-to-claude'] as const;

/** The directory, inside the source dir, that holds the import record. */
export const RECORD_DIR = '.import';

/** The record's file name inside {@link RECORD_DIR}. */
export const RECORD_FILE = 'record.json';

/**
 * Why a zip import left an archive entry out: `macos-metadata` for an entry
 * under a top-level `__MACOSX/` folder, `ds-store` for a `.DS_Store` file at
 * any depth.
 */
export const DROP_REASONS = ['macos-metadata', 'ds-store'] as const;

/** A SHA-256 digest as lowercase hex. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const fileHashSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(SHA256_PATTERN, { error: 'must be 64 lowercase hex digits' }),
});

const droppedEntrySchema = z.object({
  path: z.string().min(1),
  reason: z.enum(DROP_REASONS),
});

/**
 * Validates `.import/record.json`.
 *
 * - `kind` — one of {@link IMPORT_KINDS}.
 * - `originalPath` — the source as the caller gave it.
 * - `importedAt` — an ISO 8601 date-time.
 * - `files` — `{ path, sha256 }` per file, paths POSIX-relative to the
 *   source dir.
 * - `dropped` — `{ path, reason }` per archive entry left out, `path` the
 *   entry name as the zip holds it and `reason` one of
 *   {@link DROP_REASONS}. A record without the field, written before it
 *   existed, parses to `[]`.
 */
export const importRecordSchema = z.object({
  kind: z.enum(IMPORT_KINDS),
  originalPath: z.string().min(1),
  importedAt: z.iso.datetime(),
  files: z.array(fileHashSchema),
  dropped: z.array(droppedEntrySchema).default(() => []),
});

/** A parsed import record. */
export type ImportRecord = z.infer<typeof importRecordSchema>;

/** One file's path, relative to the hashed directory, and its digest. */
export type FileHash = ImportRecord['files'][number];

/** One archive entry a zip import left out, and why. */
export type DroppedEntry = ImportRecord['dropped'][number];

/** The source of an import, as {@link writeImportRecord} takes it. */
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** What {@link writeImportRecord} records. */
export interface WriteRecordOptions {
  /** The directory the files were placed in; the record lands inside it. */
  readonly sourceDir: string;
  /** Where the files came from. */
  readonly kind: ImportKind;
  /** The source as the caller gave it. */
  readonly originalPath: string;
  /** The import time; the current time by default. */
  readonly now?: Date;
  /** The archive entries left out, sorted by path; `[]` by default. */
  readonly dropped?: readonly DroppedEntry[];
}

function sha256Of(filePath: string): string {
  return createHash('sha256')
    .update(readFileSync(filePath))
    .digest('hex');
}

/** Orders by path, code unit by code unit, independent of locale. */
export function byPath(left: { readonly path: string }, right: { readonly path: string }): number {
  if (left.path === right.path) {
    return 0;
  }

  return left.path < right.path
    ? -1
    : 1;
}

function collectFiles(rootDir: string, relativeDir: string): readonly FileHash[] {
  const entries = readdirSync(join(rootDir, relativeDir), { withFileTypes: true });

  return entries.flatMap((entry) => {
    const relativePath = relativeDir === ''
      ? entry.name
      : `${relativeDir}/${entry.name}`;

    if (relativePath === RECORD_DIR) {
      return [];
    }

    if (entry.isDirectory()) {
      return collectFiles(rootDir, relativePath);
    }

    if (entry.isFile()) {
      return [{ path: relativePath, sha256: sha256Of(join(rootDir, relativePath)) }];
    }

    throw new Error(`${relativePath}: not a regular file or directory; cannot hash it`);
  });
}

/**
 * Hashes every regular file under `dir` with SHA-256.
 *
 * Paths are POSIX-relative to `dir` and sorted by code unit. The top-level
 * `.import/` directory is skipped. Any entry that is neither a regular file
 * nor a directory, such as a symlink, throws, so a record never silently
 * omits a file.
 */
export function hashDirectory(dir: string): FileHash[] {
  return [...collectFiles(dir, '')].sort(byPath);
}

/** The absolute path of the record file for a source dir. */
export function recordPath(sourceDir: string): string {
  const root = resolve(sourceDir);
  const target = resolve(root, RECORD_DIR, RECORD_FILE);
  const fromRoot = relative(root, target);

  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`${target} does not resolve inside ${root}`);
  }

  return target;
}

/**
 * Hashes the files under `sourceDir`, validates the resulting record and
 * writes it to `<sourceDir>/.import/record.json` as indented JSON, creating
 * `.import/` when it is missing and replacing any earlier record. `dropped`
 * is recorded as given, `[]` when left out.
 *
 * @returns The record as written.
 */
export function writeImportRecord(options: WriteRecordOptions): ImportRecord {
  const { sourceDir, kind, originalPath, now = new Date(), dropped = [] } = options;
  const record = importRecordSchema.parse({
    kind,
    originalPath,
    importedAt: now.toISOString(),
    files: hashDirectory(sourceDir),
    dropped,
  });
  const target = recordPath(sourceDir);

  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);

  return record;
}
