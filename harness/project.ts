/**
 * What the shared Storybook harness takes from the active project: the
 * story locations and the style entry, resolved from the project config
 * through `config/load.ts`.
 *
 * The harness's own fixture stories are always loaded, so a run that finds
 * no library story still renders one and fails if it does not render. With
 * no `D2C_PROJECT` they are the only stories. With a project, its library's
 * stories and style entry join them once they exist on disk; a target that
 * has not been generated yet adds nothing. Storybook itself only warns on a
 * story directory that does not exist, so the check keeps that warning out
 * of every run made before the library is generated.
 *
 * @packageDocumentation
 */

import type { LoadOptions } from '../config/load.ts';
import type { ProjectConfig } from '../config/schema.ts';

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadProjectConfig, PROJECT_ENV_VAR, REPO_ROOT } from '../config/load.ts';

/** The directory, relative to the repo root, of the harness's own stories. */
export const FIXTURES_DIR = 'harness/fixtures';

/** The story files the harness picks up in the fixtures directory. */
export const FIXTURE_STORY_FILES = '*.stories.tsx';

/** The directory, relative to a library's `target.dir`, holding its source. */
export const LIBRARY_SOURCE_DIR = 'src';

/** The story files the harness picks up under a library's source. */
export const LIBRARY_STORY_FILES = '**/*.stories.@(ts|tsx)';

/**
 * A library's style entry, relative to its `target.dir`; the path the
 * library template exports as `./styles.css`.
 */
export const LIBRARY_STYLE_ENTRY = 'src/styles/index.css';

/** A Storybook stories specifier; `directory` is absolute. */
export interface StorySpecifier {
  /** The absolute directory the `files` glob is matched under. */
  readonly directory: string;
  /** The glob of story files under `directory`. */
  readonly files: string;
  /** The prefix of every story title from this specifier. */
  readonly titlePrefix: string;
}

/** What the harness loads for the active project. */
export interface HarnessProject {
  /** The active project's config, or `undefined` with no `D2C_PROJECT`. */
  readonly config: ProjectConfig | undefined;
  /** The stories to load; the fixture specifier always comes first. */
  readonly stories: readonly StorySpecifier[];
  /** The absolute path of the library's style entry, when it exists. */
  readonly styleEntry: string | undefined;
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function fixtureStories(rootDir: string): StorySpecifier {
  return {
    directory: join(rootDir, FIXTURES_DIR),
    files: FIXTURE_STORY_FILES,
    titlePrefix: 'Harness',
  };
}

function libraryStories(config: ProjectConfig, targetDir: string): StorySpecifier[] {
  const sourceDir = join(targetDir, LIBRARY_SOURCE_DIR);

  if (!isDirectory(sourceDir)) {
    return [];
  }

  return [{ directory: sourceDir, files: LIBRARY_STORY_FILES, titlePrefix: config.name }];
}

function libraryStyleEntry(targetDir: string): string | undefined {
  const styleEntry = join(targetDir, LIBRARY_STYLE_ENTRY);

  return existsSync(styleEntry)
    ? styleEntry
    : undefined;
}

/**
 * Resolves what the harness loads for the active project.
 *
 * With `D2C_PROJECT` unset or empty, the harness loads only the fixture
 * stories and no style entry. Otherwise the project's config is loaded with
 * {@link loadProjectConfig}, whose errors propagate: a broken config fails
 * the harness rather than silently falling back to the fixtures. The
 * library's stories are added when `<target.dir>/src` is a directory, and
 * its style entry when `<target.dir>/src/styles/index.css` exists.
 *
 * @param options - The environment and root to read from, as for
 *   {@link loadProjectConfig}.
 * @returns The stories and style entry, with absolute paths.
 */
export function resolveHarnessProject(options: LoadOptions = {}): HarnessProject {
  const { env = process.env, rootDir = REPO_ROOT } = options;
  const fixtures = fixtureStories(rootDir);
  const slug = env[PROJECT_ENV_VAR];

  if (slug === undefined || slug === '') {
    return { config: undefined, stories: [fixtures], styleEntry: undefined };
  }

  const config = loadProjectConfig({ env, rootDir });
  const targetDir = resolve(rootDir, config.target.dir);

  return {
    config,
    stories: [fixtures, ...libraryStories(config, targetDir)],
    styleEntry: libraryStyleEntry(targetDir),
  };
}
