/**
 * The project-config loader: resolves the active project from
 * `D2C_PROJECT`, reads and validates `projects/<slug>.json`, and checks what
 * the schema cannot — that `source.dir` exists on disk, and that the config
 * does not ask for a mode the tool does not support yet.
 *
 * Every failure is a {@link ProjectConfigError} whose message names the
 * failing field by its dotted path (`source.dir`) or the environment
 * variable (`D2C_PROJECT`), so a caller can print it as it stands.
 *
 * @packageDocumentation
 */

import type { ProjectConfig } from './schema.ts';

import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectConfigSchema, SLUG_PATTERN } from './schema.ts';

/** The environment variable that names the active project's slug. */
export const PROJECT_ENV_VAR = 'D2C_PROJECT';

/** The directory, relative to the repo root, that holds the configs. */
export const PROJECTS_DIR = 'projects';

/** The repo root, which every path in a config is relative to. */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A config that cannot be loaded; the message names the failing field. */
export class ProjectConfigError extends Error {
  override readonly name = 'ProjectConfigError';
}

/** The environment variables the loader reads, keyed by name. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** Where {@link loadProjectConfig} reads from; each field has a default. */
export interface LoadOptions {
  /** The environment to read `D2C_PROJECT` from; `process.env` by default. */
  readonly env?: Environment;
  /** The directory config paths resolve against; {@link REPO_ROOT} by default. */
  readonly rootDir?: string;
  /**
   * Whether `source.dir` must already exist as a directory; `true` by
   * default. Pass `false` for a caller that creates it, such as an import.
   */
  readonly requireSourceDir?: boolean;
}

function readSlug(env: Environment): string {
  const slug = env[PROJECT_ENV_VAR];

  if (slug === undefined || slug === '') {
    throw new ProjectConfigError(
      `${PROJECT_ENV_VAR} is not set; set it to a project slug (${PROJECTS_DIR}/<slug>.json)`,
    );
  }

  if (!SLUG_PATTERN.test(slug)) {
    throw new ProjectConfigError(
      `${PROJECT_ENV_VAR}: '${slug}' is not a slug; use lowercase letters and digits in hyphen-separated runs`,
    );
  }

  return slug;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function readJson(filePath: string, displayPath: string): unknown {
  let text: string;

  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      throw new ProjectConfigError(`${displayPath}: project file not found`);
    }

    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProjectConfigError(`${displayPath}: not valid JSON: ${(error as Error).message}`);
  }
}

function parseConfig(input: unknown, displayPath: string): ProjectConfig {
  const result = projectConfigSchema.safeParse(input);

  if (result.success) {
    return result.data;
  }

  const lines = result.error.issues.map(
    (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );

  throw new ProjectConfigError(`${displayPath}: invalid project config\n${lines.join('\n')}`);
}

function checkSupported(config: ProjectConfig, displayPath: string): void {
  if (config.storybook.mode === 'detached') {
    throw new ProjectConfigError(
      `${displayPath}: storybook.mode: 'detached' is not supported yet; use 'managed'`,
    );
  }
}

function checkSourceDir(config: ProjectConfig, rootDir: string, displayPath: string): void {
  const sourceDir = resolve(rootDir, config.source.dir);
  const stats = statSync(sourceDir, { throwIfNoEntry: false });

  if (stats === undefined) {
    throw new ProjectConfigError(
      `${displayPath}: source.dir: '${config.source.dir}' does not exist (${sourceDir})`,
    );
  }

  if (!stats.isDirectory()) {
    throw new ProjectConfigError(
      `${displayPath}: source.dir: '${config.source.dir}' is not a directory (${sourceDir})`,
    );
  }
}

/**
 * Loads the active project's config.
 *
 * Steps, each of which throws a {@link ProjectConfigError} on failure:
 * 1. read the slug from `D2C_PROJECT`, which must be set and be a slug;
 * 2. read `projects/<slug>.json` under the root and parse it as JSON;
 * 3. validate it with {@link projectConfigSchema}, filling in the defaults
 *    — the message lists every failing field by its dotted path;
 * 4. refuse `storybook.mode: 'detached'`, which is not supported yet;
 * 5. check that `source.dir`, resolved against the root, is a directory —
 *    skipped when `requireSourceDir` is `false`.
 *
 * Reading the file fails with the error `readFileSync` threw for anything
 * other than a missing file, since a permission or I/O error is not a
 * problem with the config.
 *
 * @param options - The environment and root to read from, and whether
 *   `source.dir` must exist.
 * @returns The parsed config, with every default filled in.
 */
export function loadProjectConfig(options: LoadOptions = {}): ProjectConfig {
  const { env = process.env, rootDir = REPO_ROOT, requireSourceDir = true } = options;
  const slug = readSlug(env);
  const filePath = join(rootDir, PROJECTS_DIR, `${slug}.json`);
  const displayPath = relative(rootDir, filePath);
  const config = parseConfig(readJson(filePath, displayPath), displayPath);

  checkSupported(config, displayPath);
  if (requireSourceDir) {
    checkSourceDir(config, rootDir, displayPath);
  }

  return config;
}
