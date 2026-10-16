import type { SeedManifest } from '../../seed/schema.ts';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS } from '../../../config/schema.ts';
import { SeedFileError, writeSeedManifest } from '../../seed/files.ts';
import { type GateResult, gateResultSchema, LIBRARY_COMPONENT, SCANNED_ZERO_FILES_RULE } from '../result.ts';

import {
  MISSING_COMPONENT_RULE,
  MISSING_STATE_STORY_RULE,
  readStoryExports,
  runStateCoverageGate,
  toPascalCase,
} from './index.ts';

const COMPONENT = 'export const C = () => null;\n';
const dirs: string[] = [];

/** A temp folder holding each file of `files`, keyed by POSIX path relative to it. */
function tempDir(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'd2c-state-coverage-'));

  dirs.push(dir);

  for (const [path, text] of Object.entries(files)) {
    const absolute = join(dir, path);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }

  return dir;
}

/** A manifest naming each of `components`, as `[name, state names]`, at level `atom`. */
function manifest(components: readonly (readonly [string, readonly string[]])[]): SeedManifest {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    components: components.map(([name, states]) => ({
      name,
      level: 'atom',
      page: 'index.html',
      selector: `[data-d2c=${name}]`,
      examples: [],
      states: states.map((state) => ({ name: state, mode: 'example', selector: `[data-d2c=${name}-${state}]` })),
      variantAxes: {},
      parts: [],
      docText: [],
      origin: 'markers',
    })),
  };
}

/** A source dir holding `entries` as its seed manifest. */
function sourceWith(entries: readonly (readonly [string, readonly string[]])[]): string {
  const sourceDir = tempDir({});

  writeSeedManifest(sourceDir, manifest(entries));

  return sourceDir;
}

/** Runs the gate with the default levels and a clock that ticks 5ms a call. */
function run(sourceDir: string, targetDir: string) {
  let tick = 0;

  return runStateCoverageGate({ sourceDir, targetDir, levels: DEFAULT_LEVELS, now: () => (tick += 5) });
}

/** The state-coverage result written for `component` under `targetDir`. */
function readResult(targetDir: string, component: string): GateResult {
  return gateResultSchema.parse(JSON.parse(readFileSync(join(targetDir, 'gate-results', component, 'state-coverage.json'), 'utf8')));
}

const BUTTON_STORIES = [
  'export default { title: \'Button\' };',
  'export const Default = {};',
  'export const WithIcon = {};',
  '',
].join('\n');

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('toPascalCase', () => {
  test.each([
    ['default', 'Default'],
    ['with-actions', 'WithActions'],
    ['with_icon', 'WithIcon'],
    ['is focused', 'IsFocused'],
    ['--leading--and-trailing--', 'LeadingAndTrailing'],
    ['camelCase', 'CamelCase'],
    ['size-2x', 'Size2x'],
  ])('%s reads %s', (name, pascal) => {
    expect(toPascalCase(name)).toBe(pascal);
  });
});

describe('readStoryExports', () => {
  test('reads named exports in source order, with their name property, and skips default, type and declare exports', () => {
    const targetDir = tempDir({
      'Button.stories.tsx': [
        'import type { Meta, StoryObj } from \'@storybook/react-vite\';',
        'const meta = { title: \'Button\' } satisfies Meta;',
        'export default meta;',
        'type Story = StoryObj<typeof meta>;',
        'export const Default: Story = {};',
        'export const Hovered = { name: \'hover\' } satisfies Story;',
        'export const Pressed = ({ \'name\': \'press\', args: {} }) as Story;',
        'export const Computed: Story = { name: `templated` };',
        'export const NotLiteral: Story = { name: String(1) };',
        'export function Rendered() { return null; }',
        'export type Disabled = Story;',
        'export interface Focused { readonly x: number }',
        'export declare const Ambient: Story;',
        'const local = { name: \'aliased\' };',
        'export { local as Aliased, meta as Meta2 };',
        'export { type Story as TypeOnly };',
        'export type { Story as AlsoTypeOnly };',
        'export { Elsewhere } from \'./elsewhere\';',
        'export { meta as default };',
        '',
      ].join('\n'),
    });

    expect(readStoryExports(targetDir, 'Button.stories.tsx')).toEqual([
      { identifier: 'Default', name: null },
      { identifier: 'Hovered', name: 'hover' },
      { identifier: 'Pressed', name: 'press' },
      { identifier: 'Computed', name: 'templated' },
      { identifier: 'NotLiteral', name: null },
      { identifier: 'Rendered', name: null },
      { identifier: 'Aliased', name: 'aliased' },
      { identifier: 'Meta2', name: null },
      { identifier: 'Elsewhere', name: null },
    ]);
  });

  test('a file that is not a script has no story exports', () => {
    const targetDir = tempDir({ 'Button.stories.mdx': 'export const Default = {};\n' });

    expect(readStoryExports(targetDir, 'Button.stories.mdx')).toEqual([]);
  });

  test('never imports the file: a story that throws on load is still read', () => {
    const targetDir = tempDir({ 'Boom.stories.tsx': 'throw new Error(\'loaded\');\nexport const Default = {};\n' });

    expect(readStoryExports(targetDir, 'Boom.stories.tsx')).toEqual([{ identifier: 'Default', name: null }]);
  });
});

describe('runStateCoverageGate', () => {
  test('a covered component passes, its result written as state-coverage.json, and no _library result is written', () => {
    const sourceDir = sourceWith([['Button', ['default', 'with-icon']]]);
    const targetDir = tempDir({
      'src/atoms/Button/Button.tsx': COMPONENT,
      'src/atoms/Button/Button.stories.tsx': BUTTON_STORIES,
    });

    const outcome = run(sourceDir, targetDir);

    expect(outcome.status).toBe('pass');
    expect(outcome.scannedFiles).toBe(2);
    expect(outcome.paths).toEqual([join(targetDir, 'gate-results', 'Button', 'state-coverage.json')]);
    expect(readdirSync(join(targetDir, 'gate-results'))).toEqual(['Button']);
    expect(readResult(targetDir, 'Button')).toEqual({
      gate: 'state-coverage',
      component: 'Button',
      status: 'pass',
      findings: [],
      durationMs: 5,
    });
  });

  test('a state covered by a story name property passes', () => {
    const sourceDir = sourceWith([['Button', ['hover']]]);
    const targetDir = tempDir({
      'src/atoms/Button/Button.tsx': COMPONENT,
      'src/atoms/Button/Button.stories.tsx': 'export const Hovered = { name: \'hover\' };\n',
    });

    expect(run(sourceDir, targetDir).status).toBe('pass');
  });

  test('each uncovered state is one missing-state-story finding at the stories file, and other components still pass', () => {
    const sourceDir = sourceWith([['Button', ['default', 'disabled', 'pressed']], ['Toolbar', ['default']]]);
    const targetDir = tempDir({
      'src/atoms/Button/Button.tsx': COMPONENT,
      'src/atoms/Button/Button.stories.tsx': `${BUTTON_STORIES}export type Disabled = {};\nexport const disabled = {};\n`,
      'src/molecules/Toolbar/Toolbar.tsx': COMPONENT,
      'src/molecules/Toolbar/Toolbar.stories.tsx': 'export const Default = {};\n',
    });

    const outcome = run(sourceDir, targetDir);

    expect(outcome.status).toBe('fail');
    expect(outcome.results.map((result) => [result.component, result.status])).toEqual([['Button', 'fail'], ['Toolbar', 'pass']]);
    expect(readResult(targetDir, 'Button').findings).toEqual([
      {
        rule: MISSING_STATE_STORY_RULE,
        file: 'src/atoms/Button/Button.stories.tsx',
        line: null,
        message: 'state "disabled" has no story: export one named Disabled, or give a story the name "disabled"',
      },
      {
        rule: MISSING_STATE_STORY_RULE,
        file: 'src/atoms/Button/Button.stories.tsx',
        line: null,
        message: 'state "pressed" has no story: export one named Pressed, or give a story the name "pressed"',
      },
    ]);
    expect(readResult(targetDir, 'Toolbar').status).toBe('pass');
  });

  test('a repeated state name is one finding', () => {
    const sourceDir = sourceWith([['Button', ['disabled', 'disabled']]]);
    const targetDir = tempDir({ 'src/atoms/Button/Button.stories.tsx': BUTTON_STORIES });

    expect(run(sourceDir, targetDir).results[0]?.findings).toHaveLength(1);
  });

  test('a component with no stories file fails every state, naming the missing file', () => {
    const sourceDir = sourceWith([['Button', ['default', 'hover']]]);
    const targetDir = tempDir({ 'src/atoms/Button/Button.tsx': COMPONENT });

    const findings = run(sourceDir, targetDir).results[0]?.findings;

    expect(findings?.map((finding) => [finding.rule, finding.file, finding.message])).toEqual([
      [MISSING_STATE_STORY_RULE, 'src/atoms/Button/Button.stories.tsx', 'state "default" has no story: src/atoms/Button/Button.stories.tsx does not exist'],
      [MISSING_STATE_STORY_RULE, 'src/atoms/Button/Button.stories.tsx', 'state "hover" has no story: src/atoms/Button/Button.stories.tsx does not exist'],
    ]);
  });

  test('a manifest entry with no component folder is one missing-component finding under its name', () => {
    const sourceDir = sourceWith([['Button', ['default']], ['Card', ['default', 'hover']]]);
    const targetDir = tempDir({
      'src/atoms/Button/Button.tsx': COMPONENT,
      'src/atoms/Button/Button.stories.tsx': BUTTON_STORIES,
    });

    const outcome = run(sourceDir, targetDir);

    expect(outcome.status).toBe('fail');
    expect(outcome.results.map((result) => result.component)).toEqual(['Button', 'Card']);
    expect(readResult(targetDir, 'Card')).toEqual({
      gate: 'state-coverage',
      component: 'Card',
      status: 'fail',
      findings: [{
        rule: MISSING_COMPONENT_RULE,
        file: null,
        line: null,
        message: 'the seed manifest names Card, but no level folder under src holds a Card folder',
      }],
      durationMs: 5,
    });
  });

  test('a folder outside the configured levels does not count as the component', () => {
    const sourceDir = sourceWith([['Button', ['default']]]);
    const targetDir = tempDir({
      'src/widgets/Button/Button.tsx': COMPONENT,
      'src/widgets/Button/Button.stories.tsx': BUTTON_STORIES,
    });

    expect(run(sourceDir, targetDir).results.flatMap((result) => result.findings.map((finding) => finding.rule)))
      .toEqual([MISSING_COMPONENT_RULE, SCANNED_ZERO_FILES_RULE]);
  });

  test('a library component the manifest does not name gets no result', () => {
    const sourceDir = sourceWith([['Button', ['default']]]);
    const targetDir = tempDir({
      'src/atoms/Button/Button.stories.tsx': BUTTON_STORIES,
      'src/atoms/Icon/Icon.tsx': COMPONENT,
    });

    run(sourceDir, targetDir);

    expect(readdirSync(join(targetDir, 'gate-results'))).toEqual(['Button']);
  });

  test('zero files scanned fails under _library, even with an empty manifest', () => {
    const sourceDir = sourceWith([]);
    const targetDir = tempDir({});

    const outcome = run(sourceDir, targetDir);

    expect(outcome.status).toBe('fail');
    expect(outcome.scannedFiles).toBe(0);
    expect(readResult(targetDir, LIBRARY_COMPONENT)).toEqual({
      gate: 'state-coverage',
      component: LIBRARY_COMPONENT,
      status: 'fail',
      findings: [{ rule: SCANNED_ZERO_FILES_RULE, file: null, line: null, message: 'scanned zero files in src' }],
      durationMs: 5,
    });
  });

  test('a stale _library result is removed once the library holds files', () => {
    const sourceDir = sourceWith([['Button', ['default']]]);
    const targetDir = tempDir({});
    const stale = join(targetDir, 'gate-results', LIBRARY_COMPONENT, 'state-coverage.json');

    run(sourceDir, targetDir);
    expect(existsSync(stale)).toBe(true);

    const buttonDir = join(targetDir, 'src', 'atoms', 'Button');

    mkdirSync(buttonDir, { recursive: true });
    writeFileSync(join(buttonDir, 'Button.stories.tsx'), BUTTON_STORIES);

    expect(run(sourceDir, targetDir).status).toBe('pass');
    expect(existsSync(stale)).toBe(false);
  });

  test('an invalid manifest throws SeedFileError and writes nothing', () => {
    const sourceDir = tempDir({ 'seed-manifest.json': '{ "components": [] }\n' });
    const targetDir = tempDir({ 'src/atoms/Button/Button.tsx': COMPONENT });

    expect(() => run(sourceDir, targetDir)).toThrow(SeedFileError);
    expect(existsSync(join(targetDir, 'gate-results'))).toBe(false);
  });
});
