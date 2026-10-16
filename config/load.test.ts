import type { ProjectConfig } from './schema';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { loadProjectConfig, ProjectConfigError, REPO_ROOT } from './load';

const SLUG = 'homepage';

const ENV = { D2C_PROJECT: SLUG };

let rootDir: string;

/** Writes `projects/<slug>.json` under the temporary root. */
function writeProject(content: unknown, slug = SLUG): void {
  mkdirSync(join(rootDir, 'projects'), { recursive: true });
  writeFileSync(join(rootDir, 'projects', `${slug}.json`), JSON.stringify(content));
}

/** Loads from the temporary root and returns the error it throws. */
function loadError(env: Record<string, string | undefined> = ENV): ProjectConfigError {
  try {
    loadProjectConfig({ env, rootDir });
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      return error;
    }

    throw error;
  }

  throw new Error('expected loadProjectConfig to throw');
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'd2c-config-load-test-'));
  mkdirSync(join(rootDir, 'design', SLUG), { recursive: true });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('loadProjectConfig', () => {
  test('loads a valid config with every default filled in', () => {
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` } });

    const expected: ProjectConfig = {
      slug: SLUG,
      name: SLUG,
      source: { dir: `design/${SLUG}` },
      target: { dir: `components/${SLUG}`, kind: 'component-library' },
      baselineDir: `baselines/${SLUG}`,
      storybook: { mode: 'managed' },
      levels: ['particles', 'atoms', 'molecules', 'organisms', 'templates', 'layouts'],
    };

    expect(loadProjectConfig({ env: ENV, rootDir })).toStrictEqual(expected);
  });

  test('rejects a config without slug, naming the field', () => {
    writeProject({ source: { dir: `design/${SLUG}` } });

    const { message } = loadError();

    expect(message).toMatch(/^projects\/homepage\.json: invalid project config\n {2}slug: /);
    expect(message.split('\n')).toHaveLength(2);
  });

  test('lists every failing field by its dotted path', () => {
    writeProject({});

    expect(loadError().message).toMatch(/\n {2}slug: .*\n {2}source\.dir: /);
  });

  test('rejects a source.dir that does not exist', () => {
    writeProject({ slug: SLUG, source: { dir: 'design/missing' } });

    expect(loadError().message).toMatch(
      /^projects\/homepage\.json: source\.dir: 'design\/missing' does not exist \(/,
    );
  });

  test('rejects a source.dir that is a file', () => {
    writeFileSync(join(rootDir, 'design', 'export.zip'), '');
    writeProject({ slug: SLUG, source: { dir: 'design/export.zip' } });

    expect(loadError().message).toContain('source.dir: \'design/export.zip\' is not a directory');
  });

  test('skips the source.dir check when requireSourceDir is false', () => {
    writeProject({ slug: SLUG, source: { dir: 'design/missing' } });

    const config = loadProjectConfig({ env: ENV, rootDir, requireSourceDir: false });

    expect(config.source.dir).toBe('design/missing');
  });

  test('checks source.dir when requireSourceDir is true', () => {
    writeProject({ slug: SLUG, source: { dir: 'design/missing' } });

    expect(() => loadProjectConfig({ env: ENV, rootDir, requireSourceDir: true })).toThrow(
      /source\.dir: 'design\/missing' does not exist/,
    );
  });

  test('still validates the schema when requireSourceDir is false', () => {
    writeProject({});

    expect(() => loadProjectConfig({ env: ENV, rootDir, requireSourceDir: false })).toThrow(
      ProjectConfigError,
    );
  });

  test('refuses storybook.mode detached as not supported yet', () => {
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` }, storybook: { mode: 'detached' } });

    expect(loadError().message).toBe(
      'projects/homepage.json: storybook.mode: \'detached\' is not supported yet; use \'managed\'',
    );
  });

  test('refuses detached before looking at source.dir', () => {
    writeProject({ slug: SLUG, source: { dir: 'design/missing' }, storybook: { mode: 'detached' } });

    expect(loadError().message).toContain('not supported yet');
  });

  test.each([
    ['unset', {}],
    ['empty', { D2C_PROJECT: '' }],
  ])('rejects a D2C_PROJECT that is %s, naming the variable', (_label, env) => {
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` } });

    expect(loadError(env).message).toMatch(/^D2C_PROJECT is not set/);
  });

  test('rejects a D2C_PROJECT that is not a slug before touching the disk', () => {
    expect(loadError({ D2C_PROJECT: '../homepage' }).message).toMatch(
      /^D2C_PROJECT: '\.\.\/homepage' is not a slug/,
    );
  });

  test('rejects a missing project file, naming its path', () => {
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` } });

    expect(loadError({ D2C_PROJECT: 'other' }).message).toBe(
      'projects/other.json: project file not found',
    );
  });

  test('rejects a project file that is not JSON', () => {
    mkdirSync(join(rootDir, 'projects'));
    writeFileSync(join(rootDir, 'projects', `${SLUG}.json`), '{ slug: ');

    expect(loadError().message).toMatch(/^projects\/homepage\.json: not valid JSON: /);
  });

  test('reads D2C_PROJECT from process.env by default', () => {
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` } });

    const previous = process.env.D2C_PROJECT;

    process.env.D2C_PROJECT = SLUG;

    try {
      expect(loadProjectConfig({ rootDir }).slug).toBe(SLUG);
    } finally {
      if (previous === undefined) {
        delete process.env.D2C_PROJECT;
      } else {
        process.env.D2C_PROJECT = previous;
      }
    }
  });

  test('resolves paths against the repo root by default', () => {
    expect(join(REPO_ROOT, 'config', 'load.ts')).toBe(join(import.meta.dirname, 'load.ts'));
  });
});
