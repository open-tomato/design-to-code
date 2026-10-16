import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS } from '../../../config/schema.ts';
import { type GateResult, gateResultSchema, LIBRARY_COMPONENT, SCANNED_ZERO_FILES_RULE } from '../result.ts';

import { MISSING_COMPONENT_RULE, MISSING_STATE_STORY_RULE, runStateCoverageGate } from './index.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const dirs: string[] = [];

/** A temp dir, removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'd2c-state-coverage-fixture-'));

  dirs.push(dir);

  return dir;
}

/** A temp copy of the fixture at `fixture` (relative to the fixtures folder), so results never land in the repo. */
function copyFixture(fixture: string): string {
  const dir = tempDir();

  cpSync(join(FIXTURES, fixture), dir, { recursive: true });

  return dir;
}

/** Runs the gate and reads back every written state-coverage.json, as the JSON on disk. */
function runAndRead(sourceDir: string, targetDir: string) {
  const run = runStateCoverageGate({ sourceDir, targetDir, levels: DEFAULT_LEVELS });
  const written = run.paths.map((path): GateResult => gateResultSchema.parse(JSON.parse(readFileSync(path, 'utf8'))));

  return { run, written };
}

/** The `[component, rule, file]` of every finding in `written`. */
function findingPlaces(written: readonly GateResult[]) {
  return written.flatMap((result) => result.findings.map((finding) => [result.component, finding.rule, finding.file]));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('state coverage gate over fixture libraries', () => {
  test('the passing library passes every component and writes no _library result', () => {
    const root = copyFixture('passing');
    const { run, written } = runAndRead(join(root, 'source'), join(root, 'library'));

    expect(run.status).toBe('pass');
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((result) => result.gate === 'state-coverage' && result.status === 'pass' && result.findings.length === 0)).toBe(true);
    expect(written.map((result) => result.component)).not.toContain(LIBRARY_COMPONENT);
  });

  test('the failing fixture fails on the one uncovered state and passes the other component', () => {
    const root = copyFixture('state-coverage/failing');
    const { run, written } = runAndRead(join(root, 'source'), join(root, 'library'));

    expect(run.status).toBe('fail');
    expect(findingPlaces(written)).toEqual([['Button', MISSING_STATE_STORY_RULE, 'src/atoms/Button/Button.stories.tsx']]);
    expect(written.find((result) => result.component === 'Toolbar')?.status).toBe('pass');
    expect(written.find((result) => result.component === 'Button')?.status).toBe('fail');
  });

  test('a manifest naming a component the library lacks fails with missing-component for it alone', () => {
    const root = copyFixture('passing');
    const manifestPath = join(root, 'source', 'seed-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const [template] = manifest.components;

    writeFileSync(manifestPath, JSON.stringify({ ...manifest, components: [...manifest.components, { ...template, name: 'Ghost' }] }));

    const { run, written } = runAndRead(join(root, 'source'), join(root, 'library'));
    const ghost = written.find((result) => result.component === 'Ghost');

    expect(run.status).toBe('fail');
    expect(ghost?.status).toBe('fail');
    expect(ghost?.findings.map((finding) => finding.rule)).toEqual([MISSING_COMPONENT_RULE]);
    expect(written.filter((result) => result.component !== 'Ghost').every((result) => result.status === 'pass')).toBe(true);
  });

  test('an empty folder fails with scanned-zero-files under _library', () => {
    const root = copyFixture('passing');
    const targetDir = tempDir();

    mkdirSync(join(targetDir, 'src'));

    const { run, written } = runAndRead(join(root, 'source'), targetDir);
    const library = written.find((result) => result.component === LIBRARY_COMPONENT);

    expect(run.status).toBe('fail');
    expect(library).toMatchObject({ gate: 'state-coverage', status: 'fail' });
    expect(library?.findings.map((finding) => finding.rule)).toContain(SCANNED_ZERO_FILES_RULE);
  });
});
