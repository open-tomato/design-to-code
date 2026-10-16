import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ProjectConfigError, REPO_ROOT } from '../config/load';

import {
  FIXTURE_STORY_FILES,
  FIXTURES_DIR,
  LIBRARY_STORY_FILES,
  resolveHarnessProject,
} from './project';

const SLUG = 'homepage';

const ENV = { D2C_PROJECT: SLUG };

let rootDir: string;

/** Writes `projects/<slug>.json` and creates its `source.dir`. */
function writeProject(content: Record<string, unknown> = {}): void {
  mkdirSync(join(rootDir, 'projects'), { recursive: true });
  mkdirSync(join(rootDir, 'design', SLUG), { recursive: true });
  writeFileSync(
    join(rootDir, 'projects', `${SLUG}.json`),
    JSON.stringify({ slug: SLUG, source: { dir: `design/${SLUG}` }, ...content }),
  );
}

/** Creates a file, and its parent directories, under the temporary root. */
function writeFile(relativePath: string): void {
  const filePath = join(rootDir, relativePath);

  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, '');
}

function fixtureSpecifier(root: string) {
  return {
    directory: join(root, FIXTURES_DIR),
    files: FIXTURE_STORY_FILES,
    titlePrefix: 'Harness',
  };
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'd2c-harness-project-test-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('resolveHarnessProject without a project', () => {
  test('loads only the fixtures when D2C_PROJECT is unset', () => {
    const project = resolveHarnessProject({ env: {}, rootDir });

    expect(project).toStrictEqual({
      config: undefined,
      stories: [fixtureSpecifier(rootDir)],
      styleEntry: undefined,
    });
  });

  test('loads only the fixtures when D2C_PROJECT is empty', () => {
    const project = resolveHarnessProject({ env: { D2C_PROJECT: '' }, rootDir });

    expect(project.stories).toStrictEqual([fixtureSpecifier(rootDir)]);
    expect(project.config).toBeUndefined();
  });

  test('points at the fixtures directory of the repo by default', () => {
    const project = resolveHarnessProject({ env: {} });
    const [fixtures] = project.stories;

    expect(fixtures?.directory).toBe(join(REPO_ROOT, FIXTURES_DIR));
    expect(statSync(join(REPO_ROOT, FIXTURES_DIR, 'Fixture.stories.tsx')).isFile()).toBe(true);
  });
});

describe('resolveHarnessProject with a project', () => {
  test('adds nothing while target.dir does not exist', () => {
    writeProject();

    const project = resolveHarnessProject({ env: ENV, rootDir });

    expect(project.config?.slug).toBe(SLUG);
    expect(project.stories).toStrictEqual([fixtureSpecifier(rootDir)]);
    expect(project.styleEntry).toBeUndefined();
  });

  test('adds nothing while target.dir holds no src directory', () => {
    writeProject();
    mkdirSync(join(rootDir, 'components', SLUG), { recursive: true });

    const project = resolveHarnessProject({ env: ENV, rootDir });

    expect(project.stories).toStrictEqual([fixtureSpecifier(rootDir)]);
  });

  test('adds the library stories after the fixtures once src exists', () => {
    writeProject({ name: 'Homepage' });
    mkdirSync(join(rootDir, 'components', SLUG, 'src'), { recursive: true });

    const project = resolveHarnessProject({ env: ENV, rootDir });

    expect(project.stories).toStrictEqual([
      fixtureSpecifier(rootDir),
      {
        directory: join(rootDir, 'components', SLUG, 'src'),
        files: LIBRARY_STORY_FILES,
        titlePrefix: 'Homepage',
      },
    ]);
  });

  test('prefixes library story titles with the slug when name is absent', () => {
    writeProject();
    mkdirSync(join(rootDir, 'components', SLUG, 'src'), { recursive: true });

    const project = resolveHarnessProject({ env: ENV, rootDir });

    expect(project.stories[1]?.titlePrefix).toBe(SLUG);
  });

  test('resolves the style entry when it exists', () => {
    writeProject();
    writeFile(`components/${SLUG}/src/styles/index.css`);

    const project = resolveHarnessProject({ env: ENV, rootDir });

    expect(project.styleEntry).toBe(join(rootDir, 'components', SLUG, 'src', 'styles', 'index.css'));
  });

  test('follows a target.dir set in the config', () => {
    writeProject({ target: { dir: 'libs/web' } });
    writeFile('libs/web/src/styles/index.css');
    writeFile(`components/${SLUG}/src/styles/index.css`);

    const project = resolveHarnessProject({ env: ENV, rootDir });

    expect(project.stories[1]?.directory).toBe(join(rootDir, 'libs', 'web', 'src'));
    expect(project.styleEntry).toBe(join(rootDir, 'libs', 'web', 'src', 'styles', 'index.css'));
  });

  test('fails on a config the loader refuses, naming the field', () => {
    writeProject({ source: {} });

    expect(() => resolveHarnessProject({ env: ENV, rootDir })).toThrow(ProjectConfigError);
    expect(() => resolveHarnessProject({ env: ENV, rootDir })).toThrow('source.dir');
  });

  test('fails when the project file is missing', () => {
    expect(() => resolveHarnessProject({ env: ENV, rootDir })).toThrow('project file not found');
  });
});
