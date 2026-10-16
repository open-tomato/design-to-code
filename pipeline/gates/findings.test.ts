import type { GateFinding } from './result.ts';

import { join, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { groupFindings, targetRelative, toResult } from './findings.ts';
import { gateResultSchema } from './result.ts';

const TARGET = resolve('/work/library');

/** A finding whose rule and message are both `rule`. */
function finding(rule: string): GateFinding {
  return { rule, file: null, line: null, message: rule };
}

describe('targetRelative', () => {
  test('gives a relative file inside the target as a POSIX path', () => {
    expect(targetRelative(TARGET, join('src', 'Button', 'Button.tsx'))).toBe('src/Button/Button.tsx');
  });

  test('gives an absolute file inside the target relative to it', () => {
    expect(targetRelative(TARGET, join(TARGET, 'src', 'index.ts'))).toBe('src/index.ts');
  });

  test('resolves dot segments that stay inside the target', () => {
    expect(targetRelative(TARGET, 'src/../src/./index.ts')).toBe('src/index.ts');
  });

  test('gives null for the target folder itself', () => {
    expect(targetRelative(TARGET, TARGET)).toBeNull();
    expect(targetRelative(TARGET, '.')).toBeNull();
  });

  test('gives null for a file that climbs out of the target', () => {
    expect(targetRelative(TARGET, '..')).toBeNull();
    expect(targetRelative(TARGET, '../other/file.ts')).toBeNull();
    expect(targetRelative(TARGET, resolve('/elsewhere/file.ts'))).toBeNull();
  });

  test('keeps a name that only starts with two dots inside the target', () => {
    expect(targetRelative(TARGET, '..hidden/file.ts')).toBe('..hidden/file.ts');
  });
});

describe('groupFindings', () => {
  test('gives an empty map for no pairs', () => {
    expect(groupFindings([])).toEqual(new Map());
  });

  test('groups findings by component in first-seen order, keeping each group in input order', () => {
    const [a, b, c, d] = [finding('a'), finding('b'), finding('c'), finding('d')];

    const grouped = groupFindings([['Button', a], ['_library', b], ['Button', c], ['Card', d]]);

    expect([...grouped.keys()]).toEqual(['Button', '_library', 'Card']);
    expect(grouped.get('Button')).toEqual([a, c]);
    expect(grouped.get('_library')).toEqual([b]);
    expect(grouped.get('Card')).toEqual([d]);
  });

  test('leaves the input pairs unchanged', () => {
    const pairs: readonly (readonly [string, GateFinding])[] = [['Button', finding('a')], ['Button', finding('b')]];
    const before = structuredClone(pairs);

    groupFindings(pairs);

    expect(pairs).toEqual(before);
  });
});

describe('toResult', () => {
  test('fails a component with findings, carrying them and the gate', () => {
    const findings = [finding('a'), finding('b')];

    const result = toResult('build-lint', 'Button', findings, 12);

    expect(result).toEqual({ gate: 'build-lint', component: 'Button', status: 'fail', findings, durationMs: 12 });
    expect(gateResultSchema.safeParse(result).success).toBe(true);
  });

  test('passes a component with no findings', () => {
    const result = toResult('story-health', '_library', [], 0);

    expect(result).toEqual({ gate: 'story-health', component: '_library', status: 'pass', findings: [], durationMs: 0 });
    expect(gateResultSchema.safeParse(result).success).toBe(true);
  });
});
