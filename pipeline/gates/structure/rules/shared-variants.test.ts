import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS } from '../../../../config/schema.ts';
import { listLibrary } from '../../library.ts';
import { gateFindingSchema } from '../../result.ts';

import { layerImports } from './layer-imports.ts';
import { SHARED_VARIANTS_RULE, sharedVariants } from './shared-variants.ts';

const FIXTURE_DIR = resolve(import.meta.dirname, '../../fixtures/structure/shared-variants');
const VARIANTS = 'export const v = () => \'v\';\n';
const dirs: string[] = [];

/** The rule's input for the library at `targetDir`, read with `levels`. */
function input(targetDir: string, levels: readonly string[] = DEFAULT_LEVELS) {
  return { targetDir, levels, components: listLibrary(targetDir, levels).components };
}

/** Runs the rule over the library at `targetDir`, read with `levels`. */
function run(targetDir: string, levels: readonly string[] = DEFAULT_LEVELS) {
  return sharedVariants(input(targetDir, levels));
}

/** A temp library holding each file of `files`, keyed by POSIX path relative to it. */
function tempLibrary(files: Readonly<Record<string, string>>): string {
  const targetDir = mkdtempSync(join(tmpdir(), 'd2c-shared-variants-'));

  dirs.push(targetDir);

  for (const [path, text] of Object.entries(files)) {
    const absolute = join(targetDir, path);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }

  return targetDir;
}

/** The `component file` of each finding, for compact assertions. */
function owners(targetDir: string, levels: readonly string[] = DEFAULT_LEVELS): readonly string[] {
  return run(targetDir, levels).map(({ component, finding }) => `${component} ${finding.file}`);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('sharedVariants over the fixtures', () => {
  test('the failing fixture yields one finding on the shared variants file, naming both importers', () => {
    const findings = run(join(FIXTURE_DIR, 'failing'));

    expect(findings).toEqual([
      {
        component: 'Button',
        finding: {
          rule: SHARED_VARIANTS_RULE,
          file: 'src/atoms/Button/Button.variants.ts',
          line: 1,
          message: 'Button.variants.ts (atoms) is imported by 2 components outside its folder: '
            + 'Card (src/molecules/Card/Card.tsx:3), Header (src/organisms/Header/Header.tsx:4); '
            + 'promote it to particles, the lowest level',
        },
      },
    ]);
    expect(SHARED_VARIANTS_RULE).toBe('shared-variants');

    for (const { finding } of findings) {
      expect(gateFindingSchema.parse(finding)).toEqual(finding);
    }
  });

  test('the failing fixture breaks no layer import, so it fails on this rule alone', () => {
    expect(layerImports(input(join(FIXTURE_DIR, 'failing')))).toEqual([]);
  });

  test('the passing fixture yields no finding while its library holds scanned files', () => {
    const targetDir = join(FIXTURE_DIR, 'passing');

    expect(listLibrary(targetDir, DEFAULT_LEVELS).scannedFiles).toBe(7);
    expect(run(targetDir)).toEqual([]);
  });
});

describe('sharedVariants', () => {
  test('counts a component once however many of its files import the variants, own-folder files never', () => {
    const targetDir = tempLibrary({
      'src/atoms/Button/Button.variants.ts': VARIANTS,
      'src/atoms/Button/Button.tsx': 'import { v } from \'./Button.variants\';\n',
      'src/atoms/Button/Button.stories.tsx': 'import { v } from \'../Button/Button.variants\';\n',
      'src/molecules/Card/Card.tsx': '\n\nimport { v } from \'../../atoms/Button/Button.variants\';\n',
      'src/molecules/Card/Card.stories.tsx': 'import { v } from \'../../atoms/Button/Button.variants\';\n',
    });

    expect(run(targetDir)).toEqual([]);
  });

  test('reads extensionless, `.ts`, `.js`, type, re-export and dynamic imports, and names each first import', () => {
    const targetDir = tempLibrary({
      'src/atoms/Button/Button.variants.ts': VARIANTS,
      'src/molecules/A/A.tsx': 'import type { V } from \'../../atoms/Button/Button.variants.ts\';\n',
      'src/molecules/B/B.tsx': 'export { v } from \'../../atoms/Button/Button.variants.js\';\n',
      'src/molecules/C/C.tsx': '\nexport const load = () => import(\'../../atoms/Button/Button.variants\');\n',
      'src/molecules/C/Later.tsx': 'import { v } from \'../../atoms/Button/Button.variants\';\n',
    });
    const [finding] = run(targetDir);

    expect(finding?.finding.message).toBe('Button.variants.ts (atoms) is imported by 3 components outside its folder: '
      + 'A (src/molecules/A/A.tsx:1), B (src/molecules/B/B.tsx:1), C (src/molecules/C/C.tsx:2); '
      + 'promote it to particles, the lowest level');
  });

  test('counts importers of the same and higher levels, a sibling with a prefixed name included', () => {
    const targetDir = tempLibrary({
      'src/atoms/Button/Button.variants.ts': VARIANTS,
      'src/atoms/ButtonGroup/ButtonGroup.tsx': 'import { v } from \'../Button/Button.variants\';\n',
      'src/layouts/Page/Page.tsx': 'import { v } from \'../../atoms/Button/Button.variants\';\n',
    });

    expect(owners(targetDir)).toEqual(['Button src/atoms/Button/Button.variants.ts']);
  });

  test('never flags variants already in the lowest level, read from the config\'s order', () => {
    const files = {
      'src/base/Dot/Dot.variants.ts': VARIANTS,
      'src/top/A/A.tsx': 'import { v } from \'../../base/Dot/Dot.variants\';\n',
      'src/top/B/B.tsx': 'import { v } from \'../../base/Dot/Dot.variants\';\n',
    };
    const targetDir = tempLibrary(files);

    expect(owners(targetDir, ['base', 'top'])).toEqual([]);
    expect(owners(targetDir, ['top', 'base'])).toEqual(['Dot src/base/Dot/Dot.variants.ts']);
    expect(run(targetDir, ['top', 'base'])[0]?.finding.message).toMatch(/promote it to top, the lowest level$/u);
  });

  test('ignores files that are not `<Name>.variants.ts` directly in the component folder', () => {
    const shared = (path: string) => ({
      [path]: VARIANTS,
      'src/molecules/A/A.tsx': `import { v } from '../../atoms/Button/${path.slice('src/atoms/Button/'.length, -'.ts'.length)}';\n`,
      'src/molecules/B/B.tsx': `import { v } from '../../atoms/Button/${path.slice('src/atoms/Button/'.length, -'.ts'.length)}';\n`,
    });

    expect(run(tempLibrary(shared('src/atoms/Button/Other.variants.ts')))).toEqual([]);
    expect(run(tempLibrary(shared('src/atoms/Button/parts/Button.variants.ts')))).toEqual([]);
    expect(run(tempLibrary(shared('src/atoms/Button/Button.styles.ts')))).toEqual([]);
    expect(owners(tempLibrary(shared('src/atoms/Button/Button.variants.ts')))).toEqual([
      'Button src/atoms/Button/Button.variants.ts',
    ]);
  });

  test('ignores package, alias and non-script references to the variants file', () => {
    const targetDir = tempLibrary({
      'src/atoms/Button/Button.variants.ts': VARIANTS,
      'src/molecules/A/A.tsx': 'import { v } from \'@/atoms/Button/Button.variants\';\n',
      'src/molecules/B/B.tsx': 'import { v } from \'../../atoms/Button/Button.variants\';\n',
      'src/molecules/C/notes.md': 'import { v } from \'../../atoms/Button/Button.variants\';\n',
    });

    expect(run(targetDir)).toEqual([]);
  });

  test('yields findings in component order, and nothing for a library without components or levels', () => {
    const targetDir = tempLibrary({
      'src/molecules/Menu/Menu.variants.ts': VARIANTS,
      'src/atoms/Button/Button.variants.ts': VARIANTS,
      'src/organisms/A/A.tsx': [
        'import { v } from \'../../molecules/Menu/Menu.variants\';',
        'import { w } from \'../../atoms/Button/Button.variants\';',
      ].join('\n'),
      'src/organisms/B/B.tsx': [
        'import { v } from \'../../molecules/Menu/Menu.variants\';',
        'import { w } from \'../../atoms/Button/Button.variants\';',
      ].join('\n'),
    });

    expect(owners(targetDir)).toEqual([
      'Button src/atoms/Button/Button.variants.ts',
      'Menu src/molecules/Menu/Menu.variants.ts',
    ]);
    expect(run(tempLibrary({}))).toEqual([]);
    expect(sharedVariants({ ...input(targetDir), levels: [] })).toEqual([]);
  });
});
