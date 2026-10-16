import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS } from '../../../config/schema.ts';
import { listLibrary } from '../library.ts';
import { gateFindingSchema, LIBRARY_COMPONENT } from '../result.ts';

import {
  DETERMINISM_EXPORTS,
  HARNESS_PREVIEW_PATH,
  NO_CROSS_FOLDER_BARREL_RULE,
  NO_VITEST_IN_STORIES_RULE,
  noCrossFolderBarrel,
  noVitestInStories,
  PREVIEW_DETERMINISTIC_RULE,
  previewDeterministic,
  runStaticChecks,
} from './static.ts';

const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const FAILING = join(FIXTURES, 'story-health/failing');
const PASSING_LIBRARY = join(FIXTURES, 'passing/library');
const dirs: string[] = [];

/** The static-check input for the library at `targetDir`, read with the default levels. */
function inputFor(targetDir: string, previewPath?: string) {
  return { targetDir, components: listLibrary(targetDir, DEFAULT_LEVELS).components, previewPath };
}

/** A temp dir holding each file of `files`, keyed by POSIX path relative to it. */
function tempDir(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'd2c-story-health-static-'));

  dirs.push(dir);

  for (const [path, text] of Object.entries(files)) {
    const absolute = join(dir, path);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }

  return dir;
}

/** The `component rule file:line` of each finding, for compact assertions. */
function places(findings: ReturnType<typeof runStaticChecks>): readonly string[] {
  return findings.map(({ component, finding }) => `${component} ${finding.rule} ${finding.file}:${finding.line}`);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('the static checks over the fixtures', () => {
  test('the failing fixture breaks each check, naming component, file and line', () => {
    const findings = runStaticChecks(inputFor(join(FAILING, 'library'), join(FAILING, 'preview.ts')));

    expect(places(findings)).toEqual([
      `Button ${NO_VITEST_IN_STORIES_RULE} src/atoms/Button/Button.stories.tsx:3`,
      `Toolbar ${NO_CROSS_FOLDER_BARREL_RULE} src/molecules/Toolbar/Toolbar.stories.tsx:4`,
      `Toolbar ${NO_CROSS_FOLDER_BARREL_RULE} src/molecules/Toolbar/Toolbar.stories.tsx:5`,
      `${LIBRARY_COMPONENT} ${PREVIEW_DETERMINISTIC_RULE} null:null`,
    ]);
    expect(findings[1]?.finding.message).toContain('Button\'s folder');
    expect(findings[2]?.finding.message).toContain('the library\'s src');
    expect(findings[3]?.finding.message).toContain('does not export RANDOM_SEED');

    for (const { finding } of findings) {
      expect(gateFindingSchema.parse(finding)).toEqual(finding);
    }
  });

  test('the passing library under the harness preview has no finding', () => {
    expect(runStaticChecks(inputFor(PASSING_LIBRARY))).toEqual([]);
  });

  test('control: a copy of the passing library fails once its Button story imports vitest and the src barrel', () => {
    const libraryDir = tempDir({});
    const story = join(libraryDir, 'src/atoms/Button/Button.stories.tsx');

    cpSync(PASSING_LIBRARY, libraryDir, { recursive: true });
    writeFileSync(story, `import { vi } from 'vitest';\nimport { Dot } from '../../index';\n${readFileSync(story, 'utf8')}`);

    expect(places(runStaticChecks(inputFor(libraryDir)))).toEqual([
      `Button ${NO_VITEST_IN_STORIES_RULE} src/atoms/Button/Button.stories.tsx:1`,
      `Button ${NO_CROSS_FOLDER_BARREL_RULE} src/atoms/Button/Button.stories.tsx:2`,
    ]);
  });
});

describe('noVitestInStories', () => {
  test('flags every form of vitest import in a story file, type-only included', () => {
    const targetDir = tempDir({
      'src/atoms/Button/Button.stories.tsx': [
        'import { expect } from \'vitest\';',
        'import type { Mock } from \'vitest\';',
        'import { userEvent } from \'@vitest/browser/context\';',
        'export { vi } from \'vitest\';',
        'const config = await import(\'vitest/config\');',
        'const spy = require(\'@vitest/spy\');',
        'import { other } from \'vitest-like\';',
        'import { local } from \'./vitest\';',
      ].join('\n'),
    });

    expect(noVitestInStories(inputFor(targetDir)).map(({ finding }) => finding.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('reads only story files', () => {
    const targetDir = tempDir({
      'src/atoms/Button/Button.test.ts': 'import { expect } from \'vitest\';\n',
      'src/atoms/Button/Button.tsx': 'import { vi } from \'vitest\';\n',
      'src/atoms/Button/Button.stories.ts': 'import { vi } from \'vitest\';\n',
    });

    expect(noVitestInStories(inputFor(targetDir)).map(({ finding }) => finding.file)).toEqual(['src/atoms/Button/Button.stories.ts']);
  });

  test('names the component, rule and specifier', () => {
    const targetDir = tempDir({ 'src/molecules/Card/Card.stories.tsx': '\nimport { vi } from \'vitest\';\n' });

    expect(noVitestInStories(inputFor(targetDir))).toEqual([{
      component: 'Card',
      finding: {
        rule: NO_VITEST_IN_STORIES_RULE,
        file: 'src/molecules/Card/Card.stories.tsx',
        line: 2,
        message: expect.stringContaining('imports \'vitest\''),
      },
    }]);
  });
});

describe('noCrossFolderBarrel', () => {
  /** A library whose Button and the src root both hold barrels, and Card's story reads `lines`. */
  function libraryWithCardStory(lines: readonly string[]): string {
    return tempDir({
      'src/index.ts': 'export {};\n',
      'src/atoms/Button/index.tsx': 'export {};\n',
      'src/atoms/Button/Button.tsx': 'export {};\n',
      'src/atoms/Icon/Icon.tsx': 'export {};\n',
      'src/molecules/Card/index.ts': 'export {};\n',
      'src/molecules/Card/Card.stories.tsx': lines.join('\n'),
    });
  }

  test('flags every specifier spelling of another folder\'s barrel and the src barrel', () => {
    const targetDir = libraryWithCardStory([
      'import { A } from \'../../atoms/Button\';',
      'import { B } from \'../../atoms/Button/index\';',
      'import { C } from \'../../atoms/Button/index.tsx\';',
      'export { D } from \'../../atoms/Button/\';',
      'const e = await import(\'../..\');',
      'import { F } from \'../../index.ts\';',
    ]);

    expect(noCrossFolderBarrel(inputFor(targetDir)).map(({ finding }) => finding.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('passes own-folder barrels, component files, folders with no barrel, aliases and type-only imports', () => {
    const targetDir = libraryWithCardStory([
      'import { A } from \'./index\';',
      'import { B } from \'.\';',
      'import { C } from \'../../atoms/Button/Button\';',
      'import { D } from \'../../atoms/Icon\';',
      'import { E } from \'@/atoms/Button\';',
      'import type { F } from \'../../atoms/Button\';',
      'import { type G, type H } from \'../../index\';',
      'export type { I } from \'../../atoms/Button\';',
    ]);

    expect(noCrossFolderBarrel(inputFor(targetDir))).toEqual([]);
  });

  test('a value import beside a type-only binding still counts', () => {
    const targetDir = libraryWithCardStory(['import { type A, B } from \'../../atoms/Button\';']);

    expect(noCrossFolderBarrel(inputFor(targetDir)).map(({ component }) => component)).toEqual(['Card']);
  });
});

describe('previewDeterministic', () => {
  test('the harness preview exports the fixed clock and the random seed', () => {
    expect(previewDeterministic()).toEqual([]);
    expect(previewDeterministic(HARNESS_PREVIEW_PATH)).toEqual([]);
    expect(DETERMINISM_EXPORTS).toEqual(['FIXED_CLOCK', 'RANDOM_SEED']);
  });

  test('a preview missing both exports yields one _library finding per export, with no place', () => {
    const previewPath = join(tempDir({ 'preview.ts': 'const FIXED_CLOCK = 0;\nexport default {};\n' }), 'preview.ts');
    const findings = previewDeterministic(previewPath);

    expect(findings.map(({ component, finding }) => [component, finding.rule, finding.file, finding.line])).toEqual([
      [LIBRARY_COMPONENT, PREVIEW_DETERMINISTIC_RULE, null, null],
      [LIBRARY_COMPONENT, PREVIEW_DETERMINISTIC_RULE, null, null],
    ]);
    expect(findings.map(({ finding }) => finding.message)).toEqual([
      expect.stringContaining('does not export FIXED_CLOCK'),
      expect.stringContaining('does not export RANDOM_SEED'),
    ]);
  });

  test('reads exports declared, listed or re-exported, but not as types', () => {
    const dir = tempDir({
      'listed.ts': 'const FIXED_CLOCK = 0;\nconst seed = 1;\nexport { FIXED_CLOCK, seed as RANDOM_SEED };\n',
      'reexported.ts': 'export { FIXED_CLOCK, RANDOM_SEED } from \'./elsewhere\';\n',
      'functions.ts': 'export function FIXED_CLOCK() {}\nexport let RANDOM_SEED = 1;\n',
      'types.ts': 'export type FIXED_CLOCK = number;\nexport type { RANDOM_SEED } from \'./elsewhere\';\n',
    });

    expect(previewDeterministic(join(dir, 'listed.ts'))).toEqual([]);
    expect(previewDeterministic(join(dir, 'reexported.ts'))).toEqual([]);
    expect(previewDeterministic(join(dir, 'functions.ts'))).toEqual([]);
    expect(previewDeterministic(join(dir, 'types.ts'))).toHaveLength(2);
  });

  test('a missing preview is one finding saying so', () => {
    const previewPath = join(tempDir({}), 'preview.ts');

    expect(previewDeterministic(previewPath).map(({ finding }) => finding.message)).toEqual([expect.stringContaining('does not exist')]);
  });
});
