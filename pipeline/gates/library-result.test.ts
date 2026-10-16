import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS, projectConfigSchema } from '../../config/schema.ts';

import { listLibrary } from './library.ts';
import { type GateResult, gateResultSchema, LIBRARY_COMPONENT, scannedZeroFilesFinding, writeGateResult } from './result.ts';

const FIXTURE_DIR = resolve(import.meta.dirname, 'fixtures/passing');
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'd2c-gate-library-result-'));

  dirs.push(dir);

  return dir;
}

/** A copy of the passing fixture's library, so writes never touch the checkout. */
function copyFixtureLibrary(): string {
  const targetDir = join(tempDir(), 'library');

  cpSync(join(FIXTURE_DIR, 'library'), targetDir, { recursive: true });

  return targetDir;
}

/** What a gate does with a library: one result per component, or a zero-files failure. */
function writeResultsFor(targetDir: string, levels: readonly string[]): readonly string[] {
  const library = listLibrary(targetDir, levels);

  if (library.scannedFiles === 0) {
    return [writeGateResult(targetDir, {
      gate: 'structure',
      component: LIBRARY_COMPONENT,
      status: 'fail',
      findings: [scannedZeroFilesFinding('src')],
      durationMs: 0,
    })];
  }

  return library.components.map((component) => writeGateResult(targetDir, {
    gate: 'structure',
    component: component.name,
    status: 'pass',
    findings: [],
    durationMs: component.files.length,
  }));
}

function readResult(path: string): GateResult {
  return gateResultSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('library and result writer over the passing fixture', () => {
  test('the fixture config parses with the default levels', () => {
    const config = projectConfigSchema.parse(JSON.parse(readFileSync(join(FIXTURE_DIR, 'projects/passing.json'), 'utf8')));

    expect(config.levels).toEqual([...DEFAULT_LEVELS]);
  });

  test('lists one component per default level and writes one valid pass result for each', () => {
    const targetDir = copyFixtureLibrary();
    const library = listLibrary(targetDir, DEFAULT_LEVELS);

    const paths = writeResultsFor(targetDir, DEFAULT_LEVELS);

    expect(library.components.map((component) => component.level)).toEqual([...DEFAULT_LEVELS]);
    expect(library.scannedFiles).toBeGreaterThan(0);
    expect(paths).toHaveLength(library.components.length);

    for (const [index, path] of paths.entries()) {
      const component = library.components[index];

      expect(path).toBe(join(targetDir, 'gate-results', component?.name ?? '', 'structure.json'));
      expect(readResult(path)).toMatchObject({ gate: 'structure', component: component?.name, status: 'pass', findings: [] });
    }
  });

  test('a rerun replaces earlier results and does not list gate-results as components', () => {
    const targetDir = copyFixtureLibrary();

    writeResultsFor(targetDir, DEFAULT_LEVELS);
    const before = listLibrary(targetDir, DEFAULT_LEVELS);

    writeResultsFor(targetDir, DEFAULT_LEVELS);

    expect(listLibrary(targetDir, DEFAULT_LEVELS)).toEqual(before);
    expect(readdirSync(join(targetDir, 'gate-results')).sort()).toEqual(before.components.map((c) => c.name).sort());
  });
});

describe('library and result writer over an empty folder', () => {
  test('scans zero files and writes a failing scanned-zero-files result under _library', () => {
    const targetDir = tempDir();

    const [path] = writeResultsFor(targetDir, DEFAULT_LEVELS);

    expect(listLibrary(targetDir, DEFAULT_LEVELS)).toEqual({ components: [], scannedFiles: 0 });
    expect(path).toBe(join(targetDir, 'gate-results', LIBRARY_COMPONENT, 'structure.json'));
    expect(readResult(path ?? '')).toMatchObject({
      component: LIBRARY_COMPONENT,
      status: 'fail',
      findings: [{ rule: 'scanned-zero-files', file: null, line: null }],
    });
  });

  test('a missing target dir reads as zero files too, and the writer creates it', () => {
    const targetDir = join(tempDir(), 'does-not-exist');

    const [path] = writeResultsFor(targetDir, DEFAULT_LEVELS);

    expect(existsSync(path ?? '')).toBe(true);
    expect(readResult(path ?? '').status).toBe('fail');
  });
});

describe('library and result writer over renamed level folders', () => {
  const renamed = { particles: 'tokens', atoms: 'elements', molecules: 'blocks' } as const;

  function renamedLibrary(): { targetDir: string; levels: readonly string[] } {
    const targetDir = copyFixtureLibrary();

    for (const [from, to] of Object.entries(renamed)) {
      renameSync(join(targetDir, 'src', from), join(targetDir, 'src', to));
    }

    const levels = DEFAULT_LEVELS.map((level) => (level in renamed
      ? renamed[level as keyof typeof renamed]
      : level));

    return { targetDir, levels };
  }

  test('lists the components through the renamed levels, in the given order', () => {
    const { targetDir, levels } = renamedLibrary();
    const original = listLibrary(copyFixtureLibrary(), DEFAULT_LEVELS);
    const library = listLibrary(targetDir, levels);

    expect(library.components.map((component) => component.level)).toEqual(levels);
    expect(library.components.map((component) => component.name)).toEqual(original.components.map((component) => component.name));
    expect(library.scannedFiles).toBe(original.scannedFiles);
  });

  test('the default levels find only the folders that kept their names', () => {
    const { targetDir } = renamedLibrary();

    const library = listLibrary(targetDir, DEFAULT_LEVELS);

    expect(library.components.map((component) => component.level)).toEqual(['organisms', 'templates', 'layouts']);
  });

  test('writes a result for every renamed-level component', () => {
    const { targetDir, levels } = renamedLibrary();

    const paths = writeResultsFor(targetDir, levels);

    expect(paths).toHaveLength(DEFAULT_LEVELS.length);
    expect(paths.every((path) => readResult(path).status === 'pass')).toBe(true);
  });

  test('levels naming no folder read as zero files and fail', () => {
    const targetDir = copyFixtureLibrary();

    mkdirSync(join(targetDir, 'gate-results'), { recursive: true });
    const [path] = writeResultsFor(targetDir, ['nope']);

    expect(readResult(path ?? '').findings[0]?.rule).toBe('scanned-zero-files');
  });
});
