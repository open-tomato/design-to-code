import type { GateResult } from './result.ts';

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';
import { ZodError } from 'zod';

import {
  GATE_NAMES,
  GATE_STATUSES,
  gateResultPath,
  gateResultSchema,
  LIBRARY_COMPONENT,
  SCANNED_ZERO_FILES_RULE,
  scannedZeroFilesFinding,
  writeGateResult,
} from './result.ts';

const FAILING: GateResult = {
  gate: 'structure',
  component: 'Button',
  status: 'fail',
  findings: [
    {
      rule: 'layer-import',
      file: 'src/atoms/Button/Button.tsx',
      line: 3,
      message: 'an atom imports a molecule',
    },
  ],
  durationMs: 12.5,
};

const PASSING: GateResult = { gate: 'structure', component: 'Button', status: 'pass', findings: [], durationMs: 4 };

const dirs: string[] = [];

function tempTargetDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'd2c-gate-result-'));

  dirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('gateResultSchema', () => {
  test('the gate names and statuses are the four local gates and three verdicts', () => {
    expect(GATE_NAMES).toEqual(['structure', 'state-coverage', 'build-lint', 'story-health']);
    expect(GATE_STATUSES).toEqual(['pass', 'fail', 'record-only']);
  });

  test('a failing and a passing result parse unchanged', () => {
    expect(gateResultSchema.parse(FAILING)).toEqual(FAILING);
    expect(gateResultSchema.parse(PASSING)).toEqual(PASSING);
  });

  test('a record-only result may carry findings or none', () => {
    const recorded = { ...FAILING, status: 'record-only' };

    expect(gateResultSchema.safeParse(recorded).success).toBe(true);
    expect(gateResultSchema.safeParse({ ...recorded, findings: [] }).success).toBe(true);
  });

  test('a finding with no place parses with null file and line', () => {
    const placeless = { ...FAILING, findings: [{ rule: 'r', file: null, line: null, message: 'm' }] };

    expect(gateResultSchema.safeParse(placeless).success).toBe(true);
  });

  test('a fail with no findings and a pass with findings are refused', () => {
    expect(gateResultSchema.safeParse({ ...FAILING, findings: [] }).success).toBe(false);
    expect(gateResultSchema.safeParse({ ...PASSING, findings: FAILING.findings }).success).toBe(false);
  });

  test.each([
    ['an unknown gate', { gate: 'design-vs-code' }],
    ['an unknown status', { status: 'warn' }],
    ['a component with a separator', { component: 'atoms/Button' }],
    ['a component of ..', { component: '..' }],
    ['an empty component', { component: '' }],
    ['a negative duration', { durationMs: -1 }],
    ['an infinite duration', { durationMs: Number.POSITIVE_INFINITY }],
    ['an unknown key', { extra: true }],
  ])('%s is refused', (_label, override) => {
    expect(gateResultSchema.safeParse({ ...FAILING, ...override }).success).toBe(false);
  });

  test.each([
    ['an absolute file', { file: '/src/Button.tsx' }],
    ['a file climbing out', { file: '../Button.tsx' }],
    ['a backslash file', { file: 'src\\Button.tsx' }],
    ['line 0', { line: 0 }],
    ['a fractional line', { line: 1.5 }],
    ['an empty rule', { rule: '' }],
    ['an empty message', { message: '' }],
    ['an unknown key', { column: 2 }],
  ])('a finding with %s is refused', (_label, override) => {
    const finding = { ...FAILING.findings[0], ...override };

    expect(gateResultSchema.safeParse({ ...FAILING, findings: [finding] }).success).toBe(false);
  });
});

describe('scannedZeroFilesFinding', () => {
  test('builds a placeless scanned-zero-files finding naming where the gate looked', () => {
    expect(scannedZeroFilesFinding('src')).toEqual({
      rule: 'scanned-zero-files',
      file: null,
      line: null,
      message: 'scanned zero files in src',
    });
    expect(SCANNED_ZERO_FILES_RULE).toBe('scanned-zero-files');
  });

  test('its finding fails the library pseudo-component as a valid result', () => {
    const result = {
      gate: 'story-health',
      component: LIBRARY_COMPONENT,
      status: 'fail',
      findings: [scannedZeroFilesFinding('src')],
      durationMs: 0,
    };

    expect(gateResultSchema.parse(result)).toEqual(result);
  });
});

describe('gateResultPath', () => {
  test('is gate-results/<component>/<gate>.json under the target dir', () => {
    const dir = tempTargetDir();

    expect(gateResultPath(dir, 'Button', 'build-lint')).toBe(join(dir, 'gate-results', 'Button', 'build-lint.json'));
  });

  test('refuses a component that is not one path segment', () => {
    expect(() => gateResultPath(tempTargetDir(), '../escape', 'structure')).toThrow(ZodError);
  });
});

describe('writeGateResult', () => {
  test('writes 2-space JSON with a trailing newline, creating the folders, and returns the path', () => {
    const dir = tempTargetDir();

    const path = writeGateResult(dir, FAILING);

    expect(path).toBe(join(dir, 'gate-results', 'Button', 'structure.json'));
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(FAILING, null, 2)}\n`);
  });

  test('replaces the earlier file for the same component and gate and leaves no temp file', () => {
    const dir = tempTargetDir();

    writeGateResult(dir, FAILING);
    const path = writeGateResult(dir, PASSING);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(PASSING);
    expect(readdirSync(join(dir, 'gate-results', 'Button'))).toEqual(['structure.json']);
  });

  test('keeps other gates and components side by side', () => {
    const dir = tempTargetDir();

    writeGateResult(dir, FAILING);
    writeGateResult(dir, { ...PASSING, gate: 'story-health' });
    writeGateResult(dir, { ...PASSING, component: 'Card' });

    expect([...readdirSync(join(dir, 'gate-results'))].sort()).toEqual(['Button', 'Card']);
    expect([...readdirSync(join(dir, 'gate-results', 'Button'))].sort()).toEqual(['story-health.json', 'structure.json']);
  });

  test('refuses an invalid result and writes nothing', () => {
    const dir = tempTargetDir();

    expect(() => writeGateResult(dir, { ...FAILING, findings: [] })).toThrow(ZodError);
    expect(readdirSync(dir)).toEqual([]);
  });
});
