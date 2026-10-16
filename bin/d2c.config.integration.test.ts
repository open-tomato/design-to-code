/**
 * Integration test for `bun run d2c config`, run as the real package
 * script (`bun run d2c ...`) rather than by calling {@link run} or spawning
 * `bin/d2c.ts` directly, so it exercises the script wiring in
 * `package.json` too.
 *
 * Each case that needs its own project writes a throwaway
 * `projects/<slug>.json` under the real repo root — `projects/*.json` is
 * gitignored except the tracked `example.json`, so this leaves nothing to
 * commit — and removes it afterwards, even if the assertion fails.
 *
 * @packageDocumentation
 */

import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const PROJECTS_DIR = join(import.meta.dirname, '..', 'projects');
const SOURCE_DIR = 'projects/example-source';

function projectPath(slug: string): string {
  return join(PROJECTS_DIR, `${slug}.json`);
}

/** A slug unique to this test run, valid under `SLUG_PATTERN`. */
function uniqueSlug(label: string): string {
  return `integration-${label}-${crypto.randomUUID()}`;
}

/** Runs `bun run d2c config` as a real child process. */
function runD2cConfig(env: Record<string, string | undefined>) {
  return spawnSync('bun', ['run', 'd2c', 'config'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('bun run d2c config', () => {
  const writtenPaths: string[] = [];

  afterEach(() => {
    for (const path of writtenPaths.splice(0)) {
      rmSync(path, { force: true });
    }
  });

  test('a project with slug removed exits non-zero naming slug', () => {
    const slug = uniqueSlug('no-slug');
    const path = projectPath(slug);

    writtenPaths.push(path);
    writeFileSync(path, JSON.stringify({ source: { dir: SOURCE_DIR } }));

    const result = runD2cConfig({ D2C_PROJECT: slug });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('\n  slug: ');
  });

  test('a detached project exits non-zero with "not supported yet"', () => {
    const slug = uniqueSlug('detached');
    const path = projectPath(slug);

    writtenPaths.push(path);
    writeFileSync(
      path,
      JSON.stringify({
        slug,
        source: { dir: SOURCE_DIR },
        storybook: { mode: 'detached' },
      }),
    );

    const result = runD2cConfig({ D2C_PROJECT: slug });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('not supported yet');
  });

  test('D2C_PROJECT=example prints the config with every default filled in', () => {
    const result = runD2cConfig({ D2C_PROJECT: 'example' });

    expect(result.status).toBe(0);
    // `bun run` echoes the underlying command (`$ bun bin/d2c.ts config`) to
    // stderr before it runs; only the config's own stderr output matters.
    expect(result.stderr).not.toContain('d2c config:');

    const config = JSON.parse(result.stdout);

    expect(config).toStrictEqual({
      slug: 'example',
      name: 'example',
      source: { dir: SOURCE_DIR },
      target: { dir: 'components/example', kind: 'component-library' },
      baselineDir: 'baselines/example',
      storybook: { mode: 'managed' },
      levels: ['particles', 'atoms', 'molecules', 'organisms', 'templates', 'layouts'],
    });
  });
});
