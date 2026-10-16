/**
 * The shared Storybook harness's preview: the active project's style
 * entry, the theme toolbar, the decorators every story renders in, and the
 * deterministic clock and randomness every story runs under.
 *
 * Before each story, {@link installDeterminism} freezes `Date` at
 * {@link FIXED_CLOCK} and replaces `Math.random` with a mulberry32 PRNG
 * started from {@link RANDOM_SEED}, the same instant and seed baseline
 * capture installs; the cleanup it returns restores both. Only `Date` is
 * frozen: timers, `performance.now` and animation frames run as usual.
 *
 * @packageDocumentation
 */

/* global globalThis -- ES2020; the shared globals list predates it */

import type { Decorator, Preview } from '@storybook/react-vite';

// Served by the plugin `main.ts` adds: the project's style entry, or an
// empty module when there is none.
// eslint-disable-next-line import/no-unresolved -- a Vite virtual module
import 'virtual:d2c-project-style';

import { FIXED_EPOCH, RANDOM_SEED as BASELINE_RANDOM_SEED } from '../../pipeline/baseline/settings.ts';

/**
 * The instant `Date` is frozen at while a story runs, in epoch milliseconds:
 * baseline capture's {@link FIXED_EPOCH}, 2024-01-01T00:00:00Z.
 */
export const FIXED_CLOCK = FIXED_EPOCH;

/**
 * The seed `Math.random` restarts from before each story: baseline
 * capture's seed, so a story draws the sequence a captured page draws.
 */
export const RANDOM_SEED = BASELINE_RANDOM_SEED;

/** Undoes one install, restoring what it replaced. */
type Restore = () => void;

/**
 * Builds a mulberry32 PRNG started from `seed`: the generator baseline
 * capture's init script installs, as a function.
 *
 * @param seed - The 32-bit seed.
 * @returns A function yielding numbers in `[0, 1)`, the same sequence for
 * the same seed.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Replaces the global `Date` with one frozen at `time`: `Date.now()`,
 * `new Date()` and `Date()` all read `time`, while `new Date(value)` and
 * `instanceof Date` behave as before.
 */
function installFixedClock(time: number): Restore {
  const RealDate = globalThis.Date;

  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) => Reflect.construct(
      target,
      args.length === 0
        ? [time]
        : args,
      newTarget,
    ),
    apply: () => new RealDate(time).toString(),
    get: (target, property, receiver) => (property === 'now'
      ? () => time
      : Reflect.get(target, property, receiver)),
  });

  return () => {
    globalThis.Date = RealDate;
  };
}

/** Replaces `Math.random` with {@link seededRandom} started from `seed`. */
function installSeededRandom(seed: number): Restore {
  const realRandom = Math.random;

  Math.random = seededRandom(seed);

  return () => {
    Math.random = realRandom;
  };
}

/**
 * The preview's `beforeEach`: freezes `Date` at {@link FIXED_CLOCK} and
 * restarts `Math.random` from {@link RANDOM_SEED}, so every story renders
 * the same whatever ran before it.
 *
 * @returns The cleanup Storybook runs when the story is torn down, which
 * restores the real `Date` and `Math.random`.
 */
export function installDeterminism(): Restore {
  const restoreClock = installFixedClock(FIXED_CLOCK);
  const restoreRandom = installSeededRandom(RANDOM_SEED);

  return () => {
    restoreRandom();
    restoreClock();
  };
}

/** The themes the toolbar offers; the first is the default. */
const THEMES = ['light', 'dark'] as const;

type Theme = (typeof THEMES)[number];

function toTheme(value: unknown): Theme {
  return value === 'dark'
    ? 'dark'
    : 'light';
}

/** Writes the selected theme to `data-theme` on `<html>`. */
const withTheme: Decorator = (Story, context) => {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', toTheme(context.globals.theme));
  }

  return Story();
};

/**
 * The slot for the demo-frame decorator, which will wrap each story in the
 * frame its design shows it in. Until then it renders the story as it is.
 */
const withFrame: Decorator = (Story) => Story();

const preview: Preview = {
  parameters: {
    controls: {
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
  },
  globalTypes: {
    theme: {
      description: 'Color theme',
      defaultValue: THEMES[0],
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  // Later entries wrap earlier ones: the frame is inside the theme.
  decorators: [withFrame, withTheme],
  beforeEach: installDeterminism,
};

export default preview;
