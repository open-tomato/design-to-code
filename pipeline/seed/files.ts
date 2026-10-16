/**
 * Reading and writing the seed files at the top level of `source.dir`:
 * `seed-manifest.json` and `seed-rejected.json`.
 *
 * Every path goes through {@link sourceDirFile}, so a write never leaves
 * `source.dir`. A write validates its value against the schema first, so an
 * invalid value never reaches disk, then writes 2-space JSON with a trailing
 * newline to a temp file beside the target and renames it over the target,
 * so a reader never sees a half-written file.
 *
 * @packageDocumentation
 */

import type { SeedManifest, SeedRejected } from './schema.ts';
import type { z } from 'zod';

import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { sourceDirFile } from '../serve/serve-record.ts';

import { seedManifestSchema, seedRejectedSchema } from './schema.ts';

/** The manifest's file name at the top level of `source.dir`. */
const MANIFEST_FILE = 'seed-manifest.json';

/** The rejected file's file name at the top level of `source.dir`. */
const REJECTED_FILE = 'seed-rejected.json';

/** The command that writes `seed-manifest.json`, named when it is missing. */
export const SEED_COMMAND = 'bun run d2c seed';

/** A seed file that is missing, could not be read as JSON or failed its schema. */
export class SeedFileError extends Error {
  override readonly name = 'SeedFileError';

  /** The absolute path of the file refused. */
  readonly path: string;

  /** Builds the error for the file at `path`, saying why in `reason`. */
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.path = path;
  }
}

/** The absolute path of `<sourceDir>/seed-manifest.json`. */
export function seedManifestPath(sourceDir: string): string {
  return sourceDirFile(sourceDir, MANIFEST_FILE);
}

/** The absolute path of `<sourceDir>/seed-rejected.json`. */
export function seedRejectedPath(sourceDir: string): string {
  return sourceDirFile(sourceDir, REJECTED_FILE);
}

/**
 * Writes `text` to `target` through a temp file in the same directory and
 * a rename, removing the temp file when the write fails.
 */
function writeAtomically(target: string, text: string): void {
  const temp = `${target}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temp, text);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Validates `value` against `schema`, then writes it atomically to `target`. */
function writeValidated(schema: z.ZodType, target: string, value: unknown): void {
  const parsed = schema.parse(value);

  writeAtomically(target, `${JSON.stringify(parsed, null, 2)}\n`);
}

/**
 * Validates `manifest` and writes it to `<sourceDir>/seed-manifest.json`.
 *
 * @throws z.ZodError when `manifest` fails the schema; nothing is written.
 */
export function writeSeedManifest(sourceDir: string, manifest: SeedManifest): void {
  writeValidated(seedManifestSchema, seedManifestPath(sourceDir), manifest);
}

/**
 * Validates `rejected` and writes it to `<sourceDir>/seed-rejected.json`.
 *
 * @throws z.ZodError when `rejected` fails the schema; nothing is written.
 */
export function writeSeedRejected(sourceDir: string, rejected: SeedRejected): void {
  writeValidated(seedRejectedSchema, seedRejectedPath(sourceDir), rejected);
}

/**
 * Reads `path` as UTF-8 text.
 *
 * @throws SeedFileError naming `path` and {@link SEED_COMMAND} when the
 *   file does not exist; any other read error propagates unchanged.
 */
function readManifestText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new SeedFileError(path, `no seed manifest; run \`${SEED_COMMAND}\` to write it`);
    }

    throw error;
  }
}

/**
 * Reads and validates `<sourceDir>/seed-manifest.json`.
 *
 * @throws SeedFileError naming the path when the file is missing (naming
 *   {@link SEED_COMMAND} too), is not JSON or fails the schema; any other
 *   read error, such as a permission error or a folder at the path, throws
 *   the file system's error.
 */
export function readSeedManifest(sourceDir: string): SeedManifest {
  const path = seedManifestPath(sourceDir);
  const text = readManifestText(path);
  let written: unknown;

  try {
    written = JSON.parse(text);
  } catch (error) {
    throw new SeedFileError(path, `not valid JSON (${(error as Error).message})`);
  }

  const result = seedManifestSchema.safeParse(written);

  if (!result.success) {
    throw new SeedFileError(path, `fails the seed manifest schema (${result.error.message})`);
  }

  return result.data;
}
