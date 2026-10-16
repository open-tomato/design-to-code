import type { CliIo } from './d2c';
import type { AgentSpawner } from '../pipeline/assess/agent.ts';

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ImportError } from '../pipeline/import/index.ts';

import { main, run, USAGE } from './d2c';

const ENTRY_POINT = new URL('./d2c.ts', import.meta.url).pathname;

/** Spawn options that decode the child's stdout and stderr as UTF-8 strings. */
const SPAWN_OPTIONS = { encoding: 'utf8' } as const;

const SLUG = 'homepage';

const ENV = { D2C_PROJECT: SLUG };

let rootDir: string;

/** Writes `projects/<slug>.json` under the temporary root. */
function writeProject(content: unknown): void {
  mkdirSync(join(rootDir, 'projects'), { recursive: true });
  writeFileSync(join(rootDir, 'projects', `${SLUG}.json`), JSON.stringify(content));
}

/** Runs the `config` verb against the temporary root. */
function runConfig(env: Record<string, string | undefined> = ENV) {
  return run(['config'], { env, rootDir });
}

describe('run', () => {
  test('prints usage to stdout and exits 0 with no arguments', async () => {
    expect(await run([])).toEqual({ exitCode: 0, stdout: `${USAGE}\n`, stderr: '' });
  });

  test.each(['help', '-h', '--help'])('treats %s as a help request', async (argument) => {
    expect(await run([argument])).toEqual({ exitCode: 0, stdout: `${USAGE}\n`, stderr: '' });
  });

  test('names an unknown verb on stderr, follows it with usage and exits 1', async () => {
    const result = await run(['extract', '--all']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`d2c: unknown verb 'extract'\n\n${USAGE}\n`);
  });

  test('usage names the command and the project variable', () => {
    expect(USAGE.startsWith('Usage: bun run d2c <verb>')).toBe(true);
    expect(USAGE).toContain('D2C_PROJECT');
  });
});

describe('run config', () => {
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'd2c-bin-d2c-test-'));
    mkdirSync(join(rootDir, 'design', SLUG), { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test('prints the resolved config as indented JSON and exits 0', async () => {
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` } });

    const result = await runConfig();
    const expected = {
      slug: SLUG,
      name: SLUG,
      source: { dir: `design/${SLUG}` },
      target: { dir: `components/${SLUG}`, kind: 'component-library' },
      baselineDir: `baselines/${SLUG}`,
      storybook: { mode: 'managed' },
      levels: ['particles', 'atoms', 'molecules', 'organisms', 'templates', 'layouts'],
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toStrictEqual(expected);
    expect(result.stdout).toContain('\n  "slug": "homepage",\n');
    expect(result.stdout.endsWith('}\n')).toBe(true);
  });

  test('names a missing slug on stderr and exits 1', async () => {
    writeProject({ source: { dir: `design/${SLUG}` } });

    const result = await runConfig();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.startsWith('d2c config: projects/homepage.json: invalid project config\n')).toBe(true);
    expect(result.stderr).toContain('\n  slug: ');
  });

  test('names every missing required field', async () => {
    writeProject({});

    const { stderr } = await runConfig();

    expect(stderr).toContain('\n  slug: ');
    expect(stderr).toContain('\n  source.dir: ');
  });

  test('refuses detached mode as not supported yet and exits 1', async () => {
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` }, storybook: { mode: 'detached' } });

    const result = await runConfig();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('storybook.mode: \'detached\' is not supported yet');
  });

  test('names a source.dir that does not exist and exits 1', async () => {
    writeProject({ slug: SLUG, source: { dir: 'design/absent' } });

    const result = await runConfig();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('source.dir: \'design/absent\' does not exist');
  });

  test('names D2C_PROJECT when it is unset and exits 1', async () => {
    const result = await runConfig({});

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.startsWith('d2c config: D2C_PROJECT is not set')).toBe(true);
  });

  test('names a missing project file and exits 1', async () => {
    const result = await runConfig();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('d2c config: projects/homepage.json: project file not found\n');
  });
});

describe('main', () => {
  /** An {@link CliIo} that keeps what `main` writes. */
  function captureIo(): CliIo & { readonly out: string[]; readonly err: string[] } {
    const out: string[] = [];
    const err: string[] = [];

    return { out, err, stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  }

  /** Runs `assess` through `main` against the temporary root with `spawnAgent`. */
  function mainAssess(spawnAgent: AgentSpawner, io: CliIo) {
    return main(['assess'], { env: ENV, rootDir, spawnAgent }, io);
  }

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'd2c-bin-d2c-test-'));
    mkdirSync(join(rootDir, 'design', SLUG), { recursive: true });
    writeFileSync(join(rootDir, 'design', SLUG, 'index.html'), '<!doctype html><title>Home</title>');
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` } });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test('prints a thrown ImportError as one d2c line on stderr and returns 1', async () => {
    const io = captureIo();
    const exitCode = await mainAssess(async () => {
      throw new ImportError('the export is not importable');
    }, io);

    expect(exitCode).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err).toEqual(['d2c: the export is not importable\n']);
  });

  test('prints the stack of a TypeError thrown by the spawner under assess and returns 2', async () => {
    const io = captureIo();
    const exitCode = await mainAssess(async () => {
      throw new TypeError('spawner blew up');
    }, io);
    const stderr = io.err.join('');

    expect(exitCode).toBe(2);
    expect(io.out).toEqual([]);
    expect(stderr.startsWith('TypeError: spawner blew up\n')).toBe(true);
    expect(stderr).toMatch(/\n\s+at /);
  });

  test('prints a thrown non-Error as its string form and returns 2', async () => {
    const io = captureIo();
    const exitCode = await mainAssess(async () => {
      throw 'a bare string';
    }, io);

    expect(exitCode).toBe(2);
    expect(io.err).toEqual(['a bare string\n']);
  });

  test('passes a normal result through: its output and its exit code', async () => {
    const io = captureIo();
    const exitCode = await main(['extract'], {}, io);

    expect(exitCode).toBe(1);
    expect(io.out.join('')).toBe('');
    expect(io.err.join('')).toBe(`d2c: unknown verb 'extract'\n\n${USAGE}\n`);
  });

  test('passes usage through on stdout with exit 0', async () => {
    const io = captureIo();

    expect(await main([], {}, io)).toBe(0);
    expect(io.out.join('')).toBe(`${USAGE}\n`);
    expect(io.err.join('')).toBe('');
  });

  test('usage names the exit codes', () => {
    expect(USAGE).toContain('Exit codes:');
    expect(USAGE).toMatch(/^ {2}0 {2}/m);
    expect(USAGE).toMatch(/^ {2}1 {2}/m);
    expect(USAGE).toMatch(/^ {2}2 {2}/m);
  });
});

describe('entry point', () => {
  test('writes usage and exits 0 when run as a script', () => {
    const child = spawnSync('bun', [ENTRY_POINT], SPAWN_OPTIONS);

    expect(child.status).toBe(0);
    expect(child.stdout).toBe(`${USAGE}\n`);
  });

  test('exits 1 on an unknown verb when run as a script', () => {
    const child = spawnSync('bun', [ENTRY_POINT, 'extract'], SPAWN_OPTIONS);

    expect(child.status).toBe(1);
    expect(child.stderr.startsWith('d2c: unknown verb \'extract\'')).toBe(true);
  });

  test('prints the example project config when run as a script', () => {
    const child = spawnSync('bun', [ENTRY_POINT, 'config'], {
      ...SPAWN_OPTIONS,
      env: { ...process.env, D2C_PROJECT: 'example' },
    });

    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      slug: 'example',
      name: 'example',
      storybook: { mode: 'managed' },
    });
  });

  test('exits 1 with the loader error on stderr when run as a script', () => {
    const child = spawnSync('bun', [ENTRY_POINT, 'config'], {
      ...SPAWN_OPTIONS,
      env: { ...process.env, D2C_PROJECT: 'no-such-project' },
    });

    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe(
      'd2c config: projects/no-such-project.json: project file not found\n',
    );
  });

  test('prints nothing when imported rather than run', () => {
    const child = spawnSync('bun', ['-e', `await import(${JSON.stringify(ENTRY_POINT)})`], SPAWN_OPTIONS);

    expect(child.status).toBe(0);
    expect(child.stdout).toBe('');
  });
});

describe('entry point, import over a case collision', () => {
  const CASE_COLLISION_ZIP = new URL('../pipeline/import/fixtures/case-collision-file.zip', import.meta.url).pathname;
  const IMPORT_SLUG = 'd2c-test-import-case-collision';
  const REPO_ROOT = new URL('..', import.meta.url).pathname;
  const projectFile = join(REPO_ROOT, 'projects', `${IMPORT_SLUG}.json`);

  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'd2c-bin-d2c-test-'));
    writeFileSync(projectFile, JSON.stringify({
      slug: IMPORT_SLUG,
      source: { dir: join(tempRoot, 'source') },
    }));
  });

  afterEach(() => {
    rmSync(projectFile, { force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('exits 1 and names both spellings on stderr, with no stack trace, when run as a script', () => {
    const child = spawnSync('bun', [ENTRY_POINT, 'import', `--source=${CASE_COLLISION_ZIP}`], {
      ...SPAWN_OPTIONS,
      env: { ...process.env, D2C_PROJECT: IMPORT_SLUG },
    });

    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr.startsWith('d2c import: ')).toBe(true);
    expect(child.stderr).toContain('"A.html"');
    expect(child.stderr).toContain('"a.html"');
    expect(child.stderr).not.toMatch(/\n\s+at /);
  });
});
