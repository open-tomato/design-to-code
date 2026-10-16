import { createContext, runInContext } from 'node:vm';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { FIXED_EPOCH, RANDOM_SEED as BASELINE_RANDOM_SEED, SEEDED_RANDOM_SCRIPT } from '../pipeline/baseline/settings.ts';

/* global globalThis -- ES2020; the shared globals list predates it */

// The style entry is a Vite virtual module, served only inside Storybook.
// Bun does not hoist vi.mock above static imports, so the preview is
// imported dynamically, after the mock is registered.
vi.mock('virtual:d2c-project-style', () => ({}));

const {
  default: preview,
  FIXED_CLOCK,
  installDeterminism,
  RANDOM_SEED,
  seededRandom,
} = await import('./.storybook/preview.ts');

const SAMPLE_COUNT = 8;

const REAL_DATE = globalThis.Date;
const REAL_RANDOM = Math.random;

/** Draws `SAMPLE_COUNT` numbers from `random`. */
function draw(random: () => number): number[] {
  return Array.from({ length: SAMPLE_COUNT }, () => random());
}

/** Draws from the `Math.random` baseline capture's init script installs. */
function drawFromBaselineScript(): number[] {
  const sandbox = createContext({});
  runInContext(SEEDED_RANDOM_SCRIPT, sandbox);

  return runInContext(`Array.from({ length: ${SAMPLE_COUNT} }, () => Math.random())`, sandbox) as number[];
}

afterEach(() => {
  globalThis.Date = REAL_DATE;
  Math.random = REAL_RANDOM;
});

describe('the exported constants', () => {
  test('fix the clock at 2024-01-01T00:00:00Z, baseline capture\'s epoch', () => {
    expect(new Date(FIXED_CLOCK).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(FIXED_CLOCK).toBe(FIXED_EPOCH);
  });

  test('seed the random sequence with baseline capture\'s seed', () => {
    expect(RANDOM_SEED).toBe(BASELINE_RANDOM_SEED);
  });
});

describe('seededRandom', () => {
  test('yields the sequence baseline capture\'s init script yields', () => {
    expect(draw(seededRandom(RANDOM_SEED))).toEqual(drawFromBaselineScript());
  });

  test('yields distinct numbers in [0, 1), and another sequence for another seed', () => {
    const sequence = draw(seededRandom(RANDOM_SEED));

    expect(new Set(sequence).size).toBe(SAMPLE_COUNT);
    expect(sequence.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(draw(seededRandom(RANDOM_SEED + 1))).not.toEqual(sequence);
  });
});

describe('installDeterminism', () => {
  test('is the preview\'s beforeEach', () => {
    expect(preview.beforeEach).toBe(installDeterminism);
  });

  test('freezes every read of the current time at the fixed clock', () => {
    installDeterminism();

    expect(Date.now()).toBe(FIXED_CLOCK);
    expect(new Date().getTime()).toBe(FIXED_CLOCK);
    expect(Date()).toBe(new REAL_DATE(FIXED_CLOCK).toString());
  });

  test('leaves dates built from a value, and instanceof, as they were', () => {
    installDeterminism();

    expect(new Date(0).toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(new Date(2020, 1, 3).getMonth()).toBe(1);
    expect(new Date()).toBeInstanceOf(REAL_DATE);
    expect(new REAL_DATE(0)).toBeInstanceOf(Date);
    expect(Date.UTC(2024, 0, 1)).toBe(FIXED_CLOCK);
  });

  test('restarts Math.random from the seed on every install', () => {
    const expected = draw(seededRandom(RANDOM_SEED));

    const cleanupFirst = installDeterminism();
    const first = draw(Math.random);
    cleanupFirst();
    installDeterminism();
    const second = draw(Math.random);

    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
  });

  test('returns a cleanup that restores the real Date and Math.random', () => {
    const cleanup = installDeterminism();

    expect(globalThis.Date).not.toBe(REAL_DATE);
    expect(Math.random).not.toBe(REAL_RANDOM);

    cleanup();

    expect(globalThis.Date).toBe(REAL_DATE);
    expect(Math.random).toBe(REAL_RANDOM);
    expect(Date.now()).not.toBe(FIXED_CLOCK);
  });
});
