import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS } from '../../../config/schema.ts';
import { type GateResult, gateResultSchema, LIBRARY_COMPONENT, SCANNED_ZERO_FILES_RULE } from '../result.ts';

import { runStructureGate, STRUCTURE_RULES } from './index.ts';
import { LAYER_IMPORTS_RULE } from './rules/layer-imports.ts';
import { NO_PAGES_FOLDER_RULE } from './rules/no-pages-folder.ts';

const COMPONENT = 'export const C = () => null;\n';
const dirs: string[] = [];

/** A temp library holding each file of `files`, keyed by POSIX path relative to it. */
function tempLibrary(files: Readonly<Record<string, string>>): string {
  const targetDir = mkdtempSync(join(tmpdir(), 'd2c-structure-gate-'));

  dirs.push(targetDir);

  for (const [path, text] of Object.entries(files)) {
    const absolute = join(targetDir, path);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }

  return targetDir;
}

/** The structure result written for `component` under `targetDir`. */
function readResult(targetDir: string, component: string): GateResult {
  return gateResultSchema.parse(JSON.parse(readFileSync(join(targetDir, 'gate-results', component, 'structure.json'), 'utf8')));
}

/** Runs the gate with the default levels and a clock that ticks 5ms a call. */
function run(targetDir: string, levels: readonly string[] = DEFAULT_LEVELS) {
  let tick = 0;

  return runStructureGate({ targetDir, levels, now: () => (tick += 5) });
}

const CLEAN = {
  'src/atoms/Button/Button.tsx': COMPONENT,
  'src/molecules/Toolbar/Toolbar.tsx': 'import { C } from \'../../atoms/Button/Button\';\n\nexport const T = C;\n',
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runStructureGate', () => {
  test('runs the four rules', () => {
    expect(STRUCTURE_RULES.map((rule) => rule.name)).toEqual(['layerImports', 'sharedVariants', 'layoutChildrenOnly', 'noPagesFolder']);
  });

  test('a clean library writes one pass per component and no _library result', () => {
    const targetDir = tempLibrary(CLEAN);

    const outcome = run(targetDir);

    expect(outcome.status).toBe('pass');
    expect(outcome.scannedFiles).toBe(2);
    expect(readdirSync(join(targetDir, 'gate-results')).sort()).toEqual(['Button', 'Toolbar']);
    expect(outcome.paths).toEqual([
      join(targetDir, 'gate-results', 'Button', 'structure.json'),
      join(targetDir, 'gate-results', 'Toolbar', 'structure.json'),
    ]);
    expect(readResult(targetDir, 'Button')).toEqual({ gate: 'structure', component: 'Button', status: 'pass', findings: [], durationMs: 5 });
    expect(readResult(targetDir, 'Toolbar').status).toBe('pass');
  });

  test('a rule finding fails its component, with file and line, and leaves the others passing', () => {
    const targetDir = tempLibrary({
      ...CLEAN,
      'src/atoms/Button/Button.tsx': `// leads\n${CLEAN['src/molecules/Toolbar/Toolbar.tsx'].replace('atoms/Button/Button', 'molecules/Toolbar/Toolbar')}`,
    });

    const outcome = run(targetDir);
    const button = readResult(targetDir, 'Button');

    expect(outcome.status).toBe('fail');
    expect(button.status).toBe('fail');
    expect(button.findings).toEqual([expect.objectContaining({ rule: LAYER_IMPORTS_RULE, file: 'src/atoms/Button/Button.tsx', line: 2 })]);
    expect(readResult(targetDir, 'Toolbar').status).toBe('pass');
    expect(existsSync(join(targetDir, 'gate-results', LIBRARY_COMPONENT))).toBe(false);
  });

  test('a library finding is written under _library, after the components', () => {
    const targetDir = tempLibrary({ ...CLEAN, 'src/pages/Home.tsx': COMPONENT });

    const outcome = run(targetDir);

    expect(outcome.status).toBe('fail');
    expect(outcome.results.map((result) => result.component)).toEqual(['Button', 'Toolbar', LIBRARY_COMPONENT]);
    expect(readResult(targetDir, LIBRARY_COMPONENT)).toMatchObject({
      status: 'fail',
      findings: [{ rule: NO_PAGES_FOLDER_RULE, file: 'src/pages', line: null }],
    });
    expect(readResult(targetDir, 'Button').status).toBe('pass');
  });

  test('an empty folder fails with scanned-zero-files under _library', () => {
    const targetDir = tempLibrary({});

    const outcome = run(targetDir);

    expect(outcome).toMatchObject({ status: 'fail', scannedFiles: 0 });
    expect(readdirSync(join(targetDir, 'gate-results'))).toEqual([LIBRARY_COMPONENT]);
    expect(readResult(targetDir, LIBRARY_COMPONENT)).toMatchObject({
      status: 'fail',
      findings: [{ rule: SCANNED_ZERO_FILES_RULE, file: null, line: null, message: 'scanned zero files in src' }],
    });
  });

  test('levels naming no folder of a full library scan zero files and fail', () => {
    const targetDir = tempLibrary(CLEAN);

    const outcome = run(targetDir, ['nope']);

    expect(outcome.status).toBe('fail');
    expect(readResult(targetDir, LIBRARY_COMPONENT).findings.map((finding) => finding.rule)).toEqual([SCANNED_ZERO_FILES_RULE]);
  });

  test('zero files and a pages folder both land under _library, zero files first', () => {
    const targetDir = tempLibrary({ 'src/pages/Home.tsx': COMPONENT });

    run(targetDir);

    expect(readResult(targetDir, LIBRARY_COMPONENT).findings.map((finding) => finding.rule)).toEqual([SCANNED_ZERO_FILES_RULE, NO_PAGES_FOLDER_RULE]);
  });

  test('a rerun with no library finding removes the stale _library result', () => {
    const targetDir = tempLibrary({ ...CLEAN, 'src/pages/Home.tsx': COMPONENT });

    run(targetDir);
    expect(existsSync(join(targetDir, 'gate-results', LIBRARY_COMPONENT, 'structure.json'))).toBe(true);

    rmSync(join(targetDir, 'src/pages'), { recursive: true });
    const outcome = run(targetDir);

    expect(outcome.status).toBe('pass');
    expect(existsSync(join(targetDir, 'gate-results', LIBRARY_COMPONENT, 'structure.json'))).toBe(false);
  });

  test('a component folder with no files still gets a pass result', () => {
    const targetDir = tempLibrary(CLEAN);

    mkdirSync(join(targetDir, 'src/organisms/Empty'), { recursive: true });
    run(targetDir);

    expect(readResult(targetDir, 'Empty').status).toBe('pass');
  });

  test('throws on a level that is not a single folder name, writing nothing', () => {
    const targetDir = tempLibrary(CLEAN);

    expect(() => run(targetDir, ['../escape'])).toThrow('is not a single folder name');
    expect(existsSync(join(targetDir, 'gate-results'))).toBe(false);
  });
});
