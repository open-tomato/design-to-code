/**
 * Integration test for `bun run d2c import` and `bun run d2c assess`, run as
 * the real package scripts (`bun run d2c ...`) rather than by calling
 * {@link run} or spawning `bin/d2c.ts` directly, so it exercises the script
 * wiring in `package.json` too.
 *
 * Each case writes a throwaway `projects/<slug>.json` under the real repo
 * root, pointing `source.dir` at a throwaway directory next to it —
 * `projects/*.json` and its sibling directories are gitignored except the
 * tracked `example.json` and `example-source/` — and removes both
 * afterwards, even if the assertion fails.
 *
 * The hash check never calls the import pipeline's own hasher; it walks the
 * placed files and hashes them itself with `node:crypto`, so a bug shared
 * between the CLI and the hasher could not hide a wrong record.
 *
 * @packageDocumentation
 */

import type { Zippable } from 'fflate';

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, test } from 'vitest';

import { discoveryReportSchema } from '../pipeline/assess/schema.ts';

const REPO_ROOT = join(import.meta.dirname, '..');
const PROJECTS_DIR = join(REPO_ROOT, 'projects');

/** The fixture export zipped into a temporary file for each test case. */
const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'index.html': '<!doctype html><html><head><title>Home</title></head><body>Home</body></html>',
  'about.html': '<!doctype html><html><head><title>About</title></head><body>About</body></html>',
  'app.js': '// page script\n',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
};

function projectPath(slug: string): string {
  return join(PROJECTS_DIR, `${slug}.json`);
}

/** A slug unique to this test run, valid under `SLUG_PATTERN`. */
function uniqueSlug(label: string): string {
  return `integration-${label}-${crypto.randomUUID()}`;
}

/** Runs `bun run d2c <args>` as a real child process. */
function runD2c(args: readonly string[], env: Record<string, string | undefined>) {
  return spawnSync('bun', ['run', 'd2c', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** Builds a zip in `dir` from entry names to text contents. */
function buildFixtureZip(dir: string): string {
  const zipPath = join(dir, 'fixture.zip');
  const entries: Zippable = Object.fromEntries(
    Object.entries(FIXTURE_FILES).map(([path, content]) => [path, strToU8(content)]),
  );

  writeFileSync(zipPath, zipSync(entries));

  return zipPath;
}

/** Every regular file under `dir`, POSIX-relative paths, sorted. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1)
      .split('\\')
      .join('/'))
    .sort();
}

/**
 * Hashes every file placed at `dir`, independently of the import
 * pipeline's own hasher, so the check proves the record against reality
 * rather than against shared code.
 */
function freshHashesOf(dir: string): { path: string; sha256: string }[] {
  return listFiles(dir)
    .filter((path) => !path.startsWith('.import/'))
    .map((path) => ({
      path,
      sha256: createHash('sha256').update(readFileSync(join(dir, path)))
        .digest('hex'),
    }));
}

describe('bun run d2c import / assess', () => {
  let workDir: string;
  let slug: string;
  let sourceDirRelative: string;
  let sourceDirAbsolute: string;

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(projectPath(slug), { force: true });
    rmSync(sourceDirAbsolute, { recursive: true, force: true });
  });

  test('import fills source.dir with one hash per file, refuses a second run without --force, and assess writes a valid discovery.json', () => {
    workDir = mkdtempSync(join(tmpdir(), 'd2c-bin-d2c-import-assess-integration-test-'));
    slug = uniqueSlug('import-assess');
    sourceDirRelative = `projects/${slug}-source`;
    sourceDirAbsolute = join(REPO_ROOT, sourceDirRelative);

    writeFileSync(projectPath(slug), JSON.stringify({ slug, source: { dir: sourceDirRelative } }));

    const zipPath = buildFixtureZip(workDir);
    const env = { D2C_PROJECT: slug };

    const firstImport = runD2c(['import', `--source=${zipPath}`], env);

    expect(firstImport.status).toBe(0);

    const record = JSON.parse(readFileSync(join(sourceDirAbsolute, '.import', 'record.json'), 'utf8')) as {
      files: { path: string; sha256: string }[];
    };

    expect(record.files).toStrictEqual(freshHashesOf(sourceDirAbsolute));
    expect(record.files).toHaveLength(Object.keys(FIXTURE_FILES).length);

    const secondImportWithoutForce = runD2c(['import', `--source=${zipPath}`], env);

    expect(secondImportWithoutForce.status).not.toBe(0);

    const secondImportWithForce = runD2c(['import', `--source=${zipPath}`, '--force'], env);

    expect(secondImportWithForce.status).toBe(0);

    const assessResult = runD2c(['assess', '--scripts-only'], env);

    expect(assessResult.status).toBe(0);

    const discovery = JSON.parse(readFileSync(join(sourceDirAbsolute, 'discovery.json'), 'utf8'));

    expect(() => discoveryReportSchema.parse(discovery)).not.toThrow();
  });
});
