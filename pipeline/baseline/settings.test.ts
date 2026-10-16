import { createContext, runInContext } from 'node:vm';

import { describe, expect, test } from 'vitest';

import {
  contextOptions,
  FIXED_EPOCH,
  RANDOM_SEED,
  SEEDED_RANDOM_SCRIPT,
  seededRandomScript,
} from './settings.ts';

const SAMPLE_COUNT = 8;

function sample(script: string): number[] {
  const sandbox = createContext({});
  runInContext(script, sandbox);
  const source = `Array.from({ length: ${SAMPLE_COUNT} }, () => Math.random())`;
  return runInContext(source, sandbox) as number[];
}

describe('seededRandomScript', () => {
  test('yields the same sequence for the same seed across two evaluations', () => {
    const first = sample(SEEDED_RANDOM_SCRIPT);
    const second = sample(SEEDED_RANDOM_SCRIPT);

    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(SAMPLE_COUNT);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  test('yields a different sequence for a different seed', () => {
    expect(sample(seededRandomScript(RANDOM_SEED + 1))).not.toEqual(sample(SEEDED_RANDOM_SCRIPT));
  });
});

describe('contextOptions', () => {
  test('carries the viewport, scale factor 1, en-US and UTC', () => {
    expect(contextOptions({ name: 'desktop', width: 1280, height: 800 })).toEqual({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      timezoneId: 'UTC',
    });
  });

  test('fixes the epoch at 2024-01-01T00:00:00Z', () => {
    expect(new Date(FIXED_EPOCH).toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });
});
