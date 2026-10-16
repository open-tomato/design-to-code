import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';

import { LIBRARY_ERROR_RULES } from '../../../templates/library/eslint.config.mjs';

/** The tool root, three folders above this one. */
const ROOT_DIR = join(import.meta.dirname, '../../..');

/** The library ESLint config every extraction copies. */
const LIBRARY_CONFIG = join(ROOT_DIR, 'templates/library/eslint.config.mjs');

/** The passing fixture's target library. */
const PASSING_LIBRARY = join(ROOT_DIR, 'pipeline/gates/fixtures/passing/library');

/** ESLint's numeric severity for `error`. */
const ERROR = 2;

/** An ESLint that lints `cwd` through the library config, as the build-and-lint gate does. */
function libraryEslint(cwd: string): ESLint {
  return new ESLint({ cwd, overrideConfigFile: LIBRARY_CONFIG });
}

/** The `.ts` and `.tsx` files under `<libraryDir>/src`, as absolute paths, sorted. */
function sourceFiles(libraryDir: string): string[] {
  return readdirSync(join(libraryDir, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => join(libraryDir, 'src', file))
    .sort();
}

/**
 * A story whose `className` is a string literal and whose `render` calls a
 * hook: the control that proves the config can fail a file.
 */
const BAD_STORY = [
  'import type { Meta, StoryObj } from \'@storybook/react-vite\';',
  '',
  'import { useState } from \'react\';',
  '',
  'import { Button } from \'./Button\';',
  '',
  'const meta = {',
  '  component: Button,',
  '} satisfies Meta<typeof Button>;',
  '',
  'export default meta;',
  '',
  'type Story = StoryObj<typeof meta>;',
  '',
  '/** A story breaking both rules. */',
  'export const Broken: Story = {',
  '  render: () => {',
  '    const [label] = useState(\'Go\');',
  '    return <span className="text-red-500">{label}</span>;',
  '  },',
  '};',
  '',
].join('\n');

describe('templates/library/eslint.config.mjs', () => {
  test('lints every source file of the passing fixture library clean', async () => {
    const results = await libraryEslint(PASSING_LIBRARY).lintFiles(['src']);

    const linted = results.map((result) => result.filePath).sort();
    expect(linted).toEqual(sourceFiles(PASSING_LIBRARY));
    expect(linted.length).toBeGreaterThan(0);
    expect(results.flatMap((result) => result.messages)).toEqual([]);
  });

  test.each(['src/atoms/Button/Button.tsx', 'src/atoms/Button/Button.variants.ts'])(
    'sets cva-only-classname and the react-hooks rules to error for %s',
    async (file) => {
      const config = await libraryEslint(PASSING_LIBRARY).calculateConfigForFile(join(PASSING_LIBRARY, file));

      expect(LIBRARY_ERROR_RULES).toContain('d2c/cva-only-classname');
      expect(LIBRARY_ERROR_RULES).toContain('react-hooks/rules-of-hooks');
      expect(LIBRARY_ERROR_RULES).toContain('react-hooks/exhaustive-deps');
      for (const rule of LIBRARY_ERROR_RULES) {
        expect([rule, config.rules[rule]?.[0]]).toEqual([rule, ERROR]);
      }
    },
  );

  test('fails a story with a literal className and a hook in its render', async () => {
    const [result] = await libraryEslint(PASSING_LIBRARY).lintText(BAD_STORY, {
      filePath: join(PASSING_LIBRARY, 'src/atoms/Button/Broken.stories.tsx'),
    });

    const errors = (result?.messages ?? [])
      .filter((message) => message.severity === ERROR)
      .map((message) => [message.ruleId, message.line]);
    expect(errors).toEqual(expect.arrayContaining([
      ['react-hooks/rules-of-hooks', 18],
      ['d2c/cva-only-classname', 19],
    ]));
  });
});
