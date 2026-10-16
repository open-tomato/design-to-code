import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS } from '../../../config/schema.ts';
import { type GateResult, gateResultSchema, LIBRARY_COMPONENT, SCANNED_ZERO_FILES_RULE } from '../result.ts';

import { runStructureGate } from './index.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const dirs: string[] = [];

/** A temp copy of the fixture library at `fixture` (relative to the fixtures folder), so results never land in the repo. */
function copyFixture(fixture: string): string {
  const targetDir = mkdtempSync(join(tmpdir(), 'd2c-structure-fixture-'));

  dirs.push(targetDir);
  cpSync(join(FIXTURES, fixture), targetDir, { recursive: true });

  return targetDir;
}

/** Runs the gate over `targetDir` and reads back every written structure.json, as the JSON on disk. */
function runAndRead(targetDir: string) {
  const run = runStructureGate({ targetDir, levels: DEFAULT_LEVELS });
  const written = run.paths.map((path): GateResult => gateResultSchema.parse(JSON.parse(readFileSync(path, 'utf8'))));

  return { run, written };
}

/** The `[component, rule, file, line]` of every finding in `written`. */
function findingPlaces(written: readonly GateResult[]) {
  return written.flatMap((result) => result.findings.map((finding) => [result.component, finding.rule, finding.file, finding.line]));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('structure gate over fixture libraries', () => {
  test('the passing library passes every component and writes no _library result', () => {
    const { run, written } = runAndRead(copyFixture('passing/library'));

    expect(run.status).toBe('pass');
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((result) => result.gate === 'structure' && result.status === 'pass' && result.findings.length === 0)).toBe(true);
    expect(written.map((result) => result.component)).not.toContain(LIBRARY_COMPONENT);
  });

  test.each([
    ['layer-imports', [
      ['Button', 'layer-imports', 'src/atoms/Button/Button.tsx', 3],
      ['Card', 'layer-imports', 'src/molecules/Card/Card.tsx', 2],
    ]],
    ['shared-variants', [
      ['Button', 'shared-variants', 'src/atoms/Button/Button.variants.ts', 1],
    ]],
    ['layout-children-only', [
      ['Page', 'layout-children-only', 'src/layouts/Page/Page.tsx', 18],
      ['Page', 'layout-children-only', 'src/layouts/Page/Page.tsx', 19],
    ]],
    ['no-pages-folder', [
      [LIBRARY_COMPONENT, 'no-pages-folder', 'src/organisms/Header/pages', null],
      [LIBRARY_COMPONENT, 'no-pages-folder', 'src/pages', null],
    ]],
  ])('the %s failing fixture fails with its findings in the written JSON', (rule, expected) => {
    const { run, written } = runAndRead(copyFixture(`structure/${rule}/failing`));

    expect(run.status).toBe('fail');
    expect(findingPlaces(written)).toEqual(expected);
    expect(written.filter((result) => result.findings.length > 0).every((result) => result.status === 'fail')).toBe(true);
  });

  test.each(['layer-imports', 'shared-variants', 'layout-children-only', 'no-pages-folder'])(
    'the %s passing fixture passes',
    (rule) => {
      const { run, written } = runAndRead(copyFixture(`structure/${rule}/passing`));

      expect(run.status).toBe('pass');
      expect(findingPlaces(written)).toEqual([]);
    },
  );

  test('an empty folder fails with scanned-zero-files under _library', () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'd2c-structure-fixture-'));

    dirs.push(targetDir);
    mkdirSync(join(targetDir, 'src'));

    const { run, written } = runAndRead(targetDir);

    expect(run.status).toBe('fail');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ gate: 'structure', component: LIBRARY_COMPONENT, status: 'fail' });
    expect(written[0]?.findings.map((finding) => finding.rule)).toEqual([SCANNED_ZERO_FILES_RULE]);
  });
});
