import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS } from '../../../../config/schema.ts';
import { listLibrary } from '../../library.ts';
import { gateFindingSchema } from '../../result.ts';

import { layerImports } from './layer-imports.ts';
import { LAYOUT_CHILDREN_ONLY_RULE, layoutChildrenOnly } from './layout-children-only.ts';
import { sharedVariants } from './shared-variants.ts';

const FIXTURE_DIR = resolve(import.meta.dirname, '../../fixtures/structure/layout-children-only');
const PAGE = 'src/layouts/Page/Page.tsx';
const dirs: string[] = [];

/** The rule's input for the library at `targetDir`, read with `levels`. */
function input(targetDir: string, levels: readonly string[] = DEFAULT_LEVELS) {
  return { targetDir, levels, components: listLibrary(targetDir, levels).components };
}

/** Runs the rule over the library at `targetDir`, read with `levels`. */
function run(targetDir: string, levels: readonly string[] = DEFAULT_LEVELS) {
  return layoutChildrenOnly(input(targetDir, levels));
}

/** A temp library holding each file of `files`, keyed by POSIX path relative to it. */
function tempLibrary(files: Readonly<Record<string, string>>): string {
  const targetDir = mkdtempSync(join(tmpdir(), 'd2c-layout-children-only-'));

  dirs.push(targetDir);

  for (const [path, text] of Object.entries(files)) {
    const absolute = join(targetDir, path);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }

  return targetDir;
}

/** The `file:line` of each finding over a library holding `files`, for compact assertions. */
function places(files: Readonly<Record<string, string>>, levels: readonly string[] = DEFAULT_LEVELS): readonly string[] {
  return run(tempLibrary(files), levels).map(({ finding }) => `${finding.file}:${finding.line}`);
}

/** A layout file importing `Button` from atoms with `importLine`, then rendering `body`. */
function page(body: string, importLine = 'import { Button } from \'../../atoms/Button/Button\';'): string {
  return `${importLine}\n\nexport const Page = () => (\n  ${body}\n);\n`;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('layoutChildrenOnly over the fixtures', () => {
  test('the failing fixture yields one finding per element passing more than children and key', () => {
    const findings = run(join(FIXTURE_DIR, 'failing'));
    const advice = 'a layout passes a library component nothing but children and key, other data reaches it through context';

    expect(findings).toEqual([
      {
        component: 'Page',
        finding: {
          rule: LAYOUT_CHILDREN_ONLY_RULE,
          file: PAGE,
          line: 18,
          message: `Page (layouts) passes title to Header; ${advice}`,
        },
      },
      {
        component: 'Page',
        finding: {
          rule: LAYOUT_CHILDREN_ONLY_RULE,
          file: PAGE,
          line: 19,
          message: `Page (layouts) passes {...rest} to Atoms.Button; ${advice}`,
        },
      },
    ]);
    expect(LAYOUT_CHILDREN_ONLY_RULE).toBe('layout-children-only');

    for (const { finding } of findings) {
      expect(gateFindingSchema.parse(finding)).toEqual(finding);
    }
  });

  test('the failing fixture breaks no other structure rule, so it fails on this rule alone', () => {
    const failing = input(join(FIXTURE_DIR, 'failing'));

    expect(layerImports(failing)).toEqual([]);
    expect(sharedVariants(failing)).toEqual([]);
  });

  test('the passing fixture yields no finding while its library holds scanned files', () => {
    const targetDir = join(FIXTURE_DIR, 'passing');

    expect(listLibrary(targetDir, DEFAULT_LEVELS).scannedFiles).toBe(5);
    expect(run(targetDir)).toEqual([]);
  });
});

describe('layoutChildrenOnly', () => {
  test('allows children and key, and refuses every other attribute and every spread, in source order', () => {
    expect(places({ [PAGE]: page('<Button key="a" children="b" />') })).toEqual([]);
    expect(places({ [PAGE]: page('<Button key="a">b</Button>') })).toEqual([]);

    const [finding] = run(tempLibrary({ [PAGE]: page('<Button tone="q" key="a" {...rest} aria-label="x" data:x="y" />') }));

    expect(finding?.finding.message).toMatch(/^Page \(layouts\) passes tone, \{\.\.\.rest\}, aria-label, data:x to Button; /u);
    expect(finding?.finding.line).toBe(4);
  });

  test('reports the line the tag opens on, for opening and self-closing elements', () => {
    expect(places({
      [PAGE]: [
        'import { Button } from \'../../atoms/Button/Button\';',
        'export const Page = () => (',
        '  <div>',
        '    <Button',
        '      tone="q"',
        '    >',
        '      <Button tone="r" />',
        '    </Button>',
        '  </div>',
        ');',
      ].join('\n'),
    })).toEqual([`${PAGE}:4`, `${PAGE}:7`]);
  });

  test('reads default, named, aliased, namespace and barrel imports of any level, extensions included', () => {
    const imports = [
      'import Default from \'../../atoms/Button/Button\';',
      'import { Card as Tile } from \'../../molecules/Card/Card.tsx\';',
      'import * as Organisms from \'../../organisms\';',
      'import { Shell } from \'../Shell/Shell.js\';',
    ].join('\n');
    const body = '<><Default a /><Tile b /><Organisms.Header.Top c /><Shell d /></>';

    expect(run(tempLibrary({ [PAGE]: page(body, imports) })).map(({ finding }) => finding.message.split(';')[0])).toEqual([
      'Page (layouts) passes a to Default',
      'Page (layouts) passes b to Tile',
      'Page (layouts) passes c to Organisms.Header.Top',
      'Page (layouts) passes d to Shell',
    ]);
  });

  test('leaves alone intrinsic elements, own-folder parts, non-level paths, packages, aliases and type imports', () => {
    const imports = [
      'import type { Button } from \'../../atoms/Button/Button\';',
      'import { type Card, Icon } from \'../../molecules/Card/Card\';',
      'import { PageFrame } from \'./PageFrame\';',
      'import { Part } from \'../Page/parts/Part\';',
      'import { Ctx } from \'../../lib/ctx\';',
      'import { External } from \'some-ui\';',
      'import { Aliased } from \'@/atoms/Aliased/Aliased\';',
    ].join('\n');
    const body = '<div a="1"><Button b /><Card c /><PageFrame d /><Part e /><Ctx.Provider f /><External g /><Aliased h /></div>';

    expect(places({ [PAGE]: page(body, imports) })).toEqual([]);
    expect(places({ [PAGE]: page('<Icon x />', imports) })).toEqual([`${PAGE}:10`]);
  });

  test('reads only the highest level, taken from the config\'s order', () => {
    const files = {
      'src/base/Dot/Dot.tsx': 'export const Dot = () => <span />;\n',
      'src/mid/Card/Card.tsx': 'import { Dot } from \'../../base/Dot/Dot\';\nexport const Card = () => <Dot tone="x" />;\n',
      'src/top/Page/Page.tsx': 'import { Dot } from \'../../base/Dot/Dot\';\nexport const Page = () => <Dot tone="y" />;\n',
    };

    expect(places(files, ['base', 'mid', 'top'])).toEqual(['src/top/Page/Page.tsx:2']);
    expect(places(files, ['top', 'base', 'mid'])).toEqual(['src/mid/Card/Card.tsx:2']);
  });

  test('skips stories, tests and non-script files of the layout, and reads its other script files', () => {
    const body = page('<Button tone="q" />');

    expect(places({
      'src/layouts/Page/Page.stories.tsx': body,
      'src/layouts/Page/Page.test.tsx': body,
      'src/layouts/Page/Page.spec.jsx': body,
      'src/layouts/Page/notes.md': body,
      'src/layouts/Page/parts/Aside.jsx': body,
      'src/layouts/Page/Page.tsx': body,
    })).toEqual(['src/layouts/Page/Page.tsx:4', 'src/layouts/Page/parts/Aside.jsx:4']);
  });

  test('yields findings in component order, and nothing for a library without components or levels', () => {
    const body = page('<Button tone="q" />');
    const targetDir = tempLibrary({ 'src/layouts/Zed/Zed.tsx': body, 'src/layouts/Alpha/Alpha.tsx': body });

    expect(run(targetDir).map(({ component }) => component)).toEqual(['Alpha', 'Zed']);
    expect(run(tempLibrary({}))).toEqual([]);
    expect(layoutChildrenOnly({ ...input(targetDir), levels: [] })).toEqual([]);
  });
});
