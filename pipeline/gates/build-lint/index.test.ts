import type { LibraryComponent } from '../library.ts';

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { REPO_ROOT } from '../../../config/load.ts';
import { DEFAULT_LEVELS } from '../../../config/schema.ts';
import { type GateResult, gateResultSchema, LIBRARY_COMPONENT, SCANNED_ZERO_FILES_RULE } from '../result.ts';

import {
  ESLINT_FATAL_RULE,
  libraryEslintConfig,
  owningComponent,
  parseTscOutput,
  runBuildLintGate,
  TEMPLATE_ESLINT_CONFIG,
  TSC_RULE,
} from './index.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

/** Each run starts `tsc` and loads the library ESLint config, which takes seconds. */
const GATE_TIMEOUT_MS = 60_000;

const dirs: string[] = [];

/** A temp folder holding each file of `files`, keyed by POSIX path relative to it. */
function tempDir(files: Readonly<Record<string, string>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'd2c-build-lint-'));

  dirs.push(dir);

  for (const [path, text] of Object.entries(files)) {
    const absolute = join(dir, path);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }

  return dir;
}

/**
 * A temp copy of the fixture library at `fixture` (relative to the fixtures
 * folder), so results never land in the repo. The copy gets the tool's
 * `node_modules` as a link, so `tsc` resolves `react` and the Storybook
 * types, and a `package.json`, without which `import/order` throws on the
 * first import it ranks.
 */
function copyLibrary(fixture: string): string {
  const dir = tempDir();

  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, 'package.json'), '{ "name": "fixture", "private": true, "type": "module" }\n');

  return dir;
}

/** Runs the gate with the default levels and a clock that ticks 5ms a call. */
function run(targetDir: string, eslintConfigFile?: string) {
  let tick = 0;

  return runBuildLintGate({ targetDir, levels: DEFAULT_LEVELS, eslintConfigFile, now: () => (tick += 5) });
}

/** The build-lint result written for `component` under `targetDir`. */
function readResult(targetDir: string, component: string): GateResult {
  return gateResultSchema.parse(JSON.parse(readFileSync(join(targetDir, 'gate-results', component, 'build-lint.json'), 'utf8')));
}

/** The `[rule, file, line]` of every finding of `result`. */
function places(result: GateResult) {
  return result.findings.map((finding) => [finding.rule, finding.file, finding.line]);
}

/** A component listed at `dir`, holding no files the tests read. */
function component(name: string, dir: string): LibraryComponent {
  return { name, level: dir.split('/')[1] ?? '', dir, files: [] };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseTscOutput', () => {
  test('reads a diagnostic placed in a file', () => {
    const output = 'src/atoms/Button/Button.tsx(17,15): error TS2322: Type \'string\' is not assignable to type \'boolean\'.\n';

    expect(parseTscOutput(output)).toEqual([
      { file: 'src/atoms/Button/Button.tsx', line: 17, message: 'TS2322: Type \'string\' is not assignable to type \'boolean\'.' },
    ]);
  });

  test('reads a diagnostic placed in no file', () => {
    expect(parseTscOutput('error TS5081: Cannot find a tsconfig.json file at the current directory: /x/tsconfig.json.\n')).toEqual([
      { file: null, line: null, message: 'TS5081: Cannot find a tsconfig.json file at the current directory: /x/tsconfig.json.' },
    ]);
  });

  test('joins indented lines onto the diagnostic above them and skips any other line', () => {
    const output = [
      'Version 7.0.2',
      'src/a.ts(2,7): error TS2322: Type \'{ a: string; }\' is not assignable to type \'{ a: number; }\'.',
      '  Types of property \'a\' are incompatible.',
      '    Type \'string\' is not assignable to type \'number\'.',
      'src/b.ts(1,1): error TS1005: \';\' expected.',
      '',
    ].join('\r\n');

    expect(parseTscOutput(output)).toEqual([
      {
        file: 'src/a.ts',
        line: 2,
        message: 'TS2322: Type \'{ a: string; }\' is not assignable to type \'{ a: number; }\'. Types of property \'a\' are incompatible. Type \'string\' is not assignable to type \'number\'.',
      },
      { file: 'src/b.ts', line: 1, message: 'TS1005: \';\' expected.' },
    ]);
  });

  test('reads nothing from empty output', () => {
    expect(parseTscOutput('')).toEqual([]);
  });
});

describe('owningComponent', () => {
  const components = [component('Button', 'src/atoms/Button'), component('Button2', 'src/atoms/Button2')];

  test('names the component whose folder holds the file, at any depth', () => {
    expect(owningComponent('src/atoms/Button/Button.tsx', components)).toBe('Button');
    expect(owningComponent('src/atoms/Button/parts/Icon.tsx', components)).toBe('Button');
    expect(owningComponent('src/atoms/Button2/Button2.tsx', components)).toBe('Button2');
  });

  test('gives a file in no component folder, or no file, to _library', () => {
    expect(owningComponent('src/lib/cn.ts', components)).toBe(LIBRARY_COMPONENT);
    expect(owningComponent('src/atoms/Button', components)).toBe(LIBRARY_COMPONENT);
    expect(owningComponent(null, components)).toBe(LIBRARY_COMPONENT);
  });
});

describe('libraryEslintConfig', () => {
  test('is the library\'s own eslint.config.mjs when it has one', () => {
    const targetDir = tempDir({ 'eslint.config.mjs': 'export default [];\n' });

    expect(libraryEslintConfig(targetDir)).toBe(join(targetDir, 'eslint.config.mjs'));
  });

  test('is the template config when the library has none', () => {
    expect(libraryEslintConfig(tempDir())).toBe(TEMPLATE_ESLINT_CONFIG);
    expect(existsSync(TEMPLATE_ESLINT_CONFIG)).toBe(true);
  });
});

describe('runBuildLintGate', () => {
  test('fails the failing fixture with each finding in its component, with file and line', async () => {
    const targetDir = copyLibrary('build-lint/failing/library');

    const gate = await run(targetDir);

    expect(gate.status).toBe('fail');
    expect(gate.results.map((result) => [result.component, result.status])).toEqual([
      ['Dot', 'pass'],
      ['Button', 'fail'],
      ['Toolbar', 'fail'],
    ]);
    expect(places(readResult(targetDir, 'Button'))).toEqual([
      ['react-hooks/rules-of-hooks', 'src/atoms/Button/Button.stories.tsx', 19],
      ['d2c/cva-only-classname', 'src/atoms/Button/Button.tsx', 17],
    ]);
    const toolbar = readResult(targetDir, 'Toolbar');
    expect(places(toolbar)).toEqual([[TSC_RULE, 'src/molecules/Toolbar/Toolbar.tsx', 17]]);
    expect(toolbar.findings[0]?.message).toMatch(/^TS2322: /);
    expect(existsSync(join(targetDir, 'gate-results', LIBRARY_COMPONENT))).toBe(false);
  }, GATE_TIMEOUT_MS);

  test('writes exactly the results it returns, each with the run\'s duration', async () => {
    const targetDir = copyLibrary('build-lint/failing/library');

    const gate = await run(targetDir);

    expect(gate.paths).toEqual(gate.results.map((result) => join(targetDir, 'gate-results', result.component, 'build-lint.json')));
    expect(gate.paths.map((path) => gateResultSchema.parse(JSON.parse(readFileSync(path, 'utf8'))))).toEqual(gate.results);
    expect(gate.results.every((result) => result.durationMs === 5)).toBe(true);
    expect(gate.scannedFiles).toBe(4);
  }, GATE_TIMEOUT_MS);

  test('passes the passing fixture library with a pass for every component and no _library result', async () => {
    const targetDir = copyLibrary('passing/library');

    const gate = await run(targetDir);

    expect(gate.status).toBe('pass');
    expect(gate.results.map((result) => [result.component, result.status])).toEqual([
      ['Dot', 'pass'],
      ['Button', 'pass'],
      ['Toolbar', 'pass'],
      ['Header', 'pass'],
      ['Stack', 'pass'],
      ['PageLayout', 'pass'],
    ]);
    expect(existsSync(join(targetDir, 'gate-results', LIBRARY_COMPONENT))).toBe(false);
  }, GATE_TIMEOUT_MS);

  test('gives a finding in a file outside every component folder to _library', async () => {
    const targetDir = copyLibrary('passing/library');
    writeFileSync(join(targetDir, 'src/lib/count.ts'), 'export const count: number = \'three\';\n');

    const gate = await run(targetDir);

    expect(gate.status).toBe('fail');
    expect(gate.results.filter((result) => result.status === 'fail').map((result) => result.component)).toEqual([LIBRARY_COMPONENT]);
    expect(places(readResult(targetDir, LIBRARY_COMPONENT))).toEqual([[TSC_RULE, 'src/lib/count.ts', 1]]);
  }, GATE_TIMEOUT_MS);

  test('removes a _library result left by an earlier run once nothing lands there', async () => {
    const targetDir = copyLibrary('passing/library');
    writeFileSync(join(targetDir, 'src/lib/count.ts'), 'export const count: number = \'three\';\n');
    await run(targetDir);
    expect(existsSync(join(targetDir, 'gate-results', LIBRARY_COMPONENT, 'build-lint.json'))).toBe(true);
    rmSync(join(targetDir, 'src/lib/count.ts'));

    const gate = await run(targetDir);

    expect(gate.status).toBe('pass');
    expect(existsSync(join(targetDir, 'gate-results', LIBRARY_COMPONENT, 'build-lint.json'))).toBe(false);
  }, GATE_TIMEOUT_MS);

  test('fails under _library with the tsc diagnostic when the library has no tsconfig.json', async () => {
    const targetDir = copyLibrary('passing/library');
    rmSync(join(targetDir, 'tsconfig.json'));

    const gate = await run(targetDir);

    expect(gate.status).toBe('fail');
    const library = readResult(targetDir, LIBRARY_COMPONENT);
    expect(places(library)).toEqual([[TSC_RULE, null, null]]);
    expect(library.findings[0]?.message).toMatch(/^TS\d+: .*tsconfig\.json/);
  }, GATE_TIMEOUT_MS);

  test('lints with the config it is given, reading a fatal message as eslint-fatal', async () => {
    const targetDir = copyLibrary('passing/library');
    const configFile = join(tempDir({ 'plain.config.mjs': 'export default [{ files: [\'**/*.tsx\'] }];\n' }), 'plain.config.mjs');

    const gate = await run(targetDir, configFile);

    expect(gate.status).toBe('fail');
    const button = readResult(targetDir, 'Button');
    expect(button.findings.length).toBeGreaterThan(0);
    expect(button.findings.every((finding) => finding.rule === ESLINT_FATAL_RULE && finding.line !== null)).toBe(true);
    expect(button.findings.map((finding) => finding.file)).toContain('src/atoms/Button/Button.tsx');
  }, GATE_TIMEOUT_MS);

  test('fails an empty folder with one scanned-zero-files finding and runs neither tool', async () => {
    const targetDir = tempDir();

    const gate = await run(targetDir);

    expect(gate.status).toBe('fail');
    expect(gate.scannedFiles).toBe(0);
    expect(gate.results).toEqual([{
      gate: 'build-lint',
      component: LIBRARY_COMPONENT,
      status: 'fail',
      findings: [{ rule: SCANNED_ZERO_FILES_RULE, file: null, line: null, message: 'scanned zero files in src' }],
      durationMs: 5,
    }]);
    expect(readResult(targetDir, LIBRARY_COMPONENT)).toEqual(gate.results[0]);
  });
});
