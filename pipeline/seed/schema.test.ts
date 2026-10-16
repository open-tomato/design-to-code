import type { ComponentEntry, SeedManifest, SeedRejected } from './schema.ts';

import { describe, expect, test } from 'vitest';

import {
  candidateSchema,
  componentEntrySchema,
  LEVELS,
  levelRank,
  REJECTION_CODES,
  seedManifestSchema,
  seedRejectedSchema,
} from './schema.ts';

const GENERATED_AT = '2026-09-30T12:00:00.000Z';

const BUTTON: ComponentEntry = {
  name: 'Button',
  level: 'atom',
  page: 'screens/components.html',
  selector: '#primary-button',
  examples: ['main > button:nth-of-type(2)'],
  states: [{ name: 'disabled', mode: 'example', selector: 'main > button:nth-of-type(3)' }],
  variantAxes: { size: ['lg', 'md', 'sm'], tone: ['primary'] },
  parts: ['icon', 'label'],
  docText: ['A button starts an action.', 'Use one primary button per view.'],
  origin: 'markers',
};

const CARD: ComponentEntry = {
  name: 'Card',
  level: 'molecule',
  page: 'screens/components.html',
  selector: 'main > article:nth-of-type(1)',
  examples: [],
  states: [{ name: 'hovered', mode: 'action', action: 'hover', target: 'main > article:nth-of-type(1) > a' }],
  variantAxes: {},
  parts: [],
  docText: [],
  origin: 'agent',
};

/** The first issue's message and path, for asserting why a parse failed. */
function firstIssue(result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) {
  const issue = result.error?.issues[0];

  return { message: issue?.message, path: issue?.path };
}

describe('LEVELS and levelRank', () => {
  test('ranks the levels lowest first, particle to layout', () => {
    expect(LEVELS.map((level) => levelRank(level))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(levelRank('particle')).toBeLessThan(levelRank('layout'));
  });
});

describe('componentEntrySchema', () => {
  test('accepts an entry with an example-mode state', () => {
    expect(componentEntrySchema.parse(BUTTON)).toEqual(BUTTON);
  });

  test('accepts an entry with an action-mode state', () => {
    expect(componentEntrySchema.parse(CARD)).toEqual(CARD);
  });

  test('refuses an unknown key', () => {
    const result = componentEntrySchema.safeParse({ ...BUTTON, colour: 'red' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  test('refuses an unknown key inside a state', () => {
    const result = componentEntrySchema.safeParse({
      ...CARD,
      states: [{ ...CARD.states[0], selector: 'a' }],
    });

    expect(result.success).toBe(false);
    expect(firstIssue(result).path).toEqual(['states', 0]);
  });

  test('refuses an unknown level', () => {
    const result = componentEntrySchema.safeParse({ ...BUTTON, level: 'widget' });

    expect(result.success).toBe(false);
    expect(firstIssue(result).path).toEqual(['level']);
  });

  test('refuses an unknown state action', () => {
    const result = componentEntrySchema.safeParse({
      ...CARD,
      states: [{ ...CARD.states[0], action: 'drag' }],
    });

    expect(result.success).toBe(false);
    expect(firstIssue(result).path).toEqual(['states', 0, 'action']);
  });

  test('refuses an empty variantAxes value list', () => {
    const result = componentEntrySchema.safeParse({ ...BUTTON, variantAxes: { size: [] } });

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toEqual({ message: 'must list at least one value', path: ['variantAxes', 'size'] });
  });

  test('refuses an unsorted variantAxes value list', () => {
    const result = componentEntrySchema.safeParse({ ...BUTTON, variantAxes: { size: ['sm', 'lg'] } });

    expect(result.success).toBe(false);
    expect(firstIssue(result).path).toEqual(['variantAxes', 'size']);
  });

  test('refuses unsorted parts', () => {
    const result = componentEntrySchema.safeParse({ ...BUTTON, parts: ['label', 'icon'] });

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toEqual({
      message: 'must be sorted by code unit with no duplicates',
      path: ['parts'],
    });
  });

  test('refuses duplicate parts', () => {
    const result = componentEntrySchema.safeParse({ ...BUTTON, parts: ['icon', 'icon'] });

    expect(result.success).toBe(false);
    expect(firstIssue(result).path).toEqual(['parts']);
  });

  test('refuses a page path that leaves the source dir', () => {
    const result = componentEntrySchema.safeParse({ ...BUTTON, page: '../outside.html' });

    expect(result.success).toBe(false);
    expect(firstIssue(result).path).toEqual(['page']);
  });

  test('refuses an entry without an origin', () => {
    const { origin, ...candidate } = BUTTON;
    const result = componentEntrySchema.safeParse(candidate);

    expect(origin).toBe('markers');
    expect(result.success).toBe(false);
    expect(firstIssue(result).path).toEqual(['origin']);
  });
});

describe('candidateSchema', () => {
  test('accepts an entry without an origin', () => {
    const { origin, ...candidate } = CARD;

    expect(origin).toBe('agent');
    expect(candidateSchema.parse(candidate)).toEqual(candidate);
  });

  test('refuses an origin, which only the runner stamps', () => {
    const result = candidateSchema.safeParse(CARD);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});

describe('seedManifestSchema', () => {
  const manifest: SeedManifest = { generatedAt: GENERATED_AT, components: [BUTTON, CARD] };

  test('accepts components with unique names', () => {
    expect(seedManifestSchema.parse(manifest)).toEqual(manifest);
  });

  test('refuses a duplicate name', () => {
    const result = seedManifestSchema.safeParse({
      ...manifest,
      components: [BUTTON, { ...CARD, name: 'Button' }],
    });

    expect(result.success).toBe(false);
    expect(firstIssue(result)).toEqual({ message: 'component names must be unique', path: ['components'] });
  });

  test('refuses a generatedAt that is not an ISO date-time', () => {
    const result = seedManifestSchema.safeParse({ ...manifest, generatedAt: 'yesterday' });

    expect(result.success).toBe(false);
    expect(firstIssue(result).path).toEqual(['generatedAt']);
  });
});

describe('seedRejectedSchema', () => {
  const rejected: SeedRejected = {
    generatedAt: GENERATED_AT,
    rejected: [
      {
        candidate: { name: 'Hero', level: 'hero', extra: [1, null, true] },
        reasons: [{ code: 'invalid-shape', detail: 'level: unknown value "hero"' }],
      },
    ],
  };

  test('accepts a candidate of any JSON shape with its reasons', () => {
    expect(seedRejectedSchema.parse(rejected)).toEqual(rejected);
  });

  test('accepts an empty rejected list', () => {
    expect(seedRejectedSchema.parse({ generatedAt: GENERATED_AT, rejected: [] }).rejected).toEqual([]);
  });

  test('accepts every rejection code', () => {
    const reasons = REJECTION_CODES.map((code) => ({ code, detail: code }));

    expect(seedRejectedSchema.safeParse({ generatedAt: GENERATED_AT, rejected: [{ candidate: null, reasons }] }).success)
      .toBe(true);
  });

  test('refuses an unknown rejection code', () => {
    const result = seedRejectedSchema.safeParse({
      generatedAt: GENERATED_AT,
      rejected: [{ candidate: {}, reasons: [{ code: 'too-big', detail: 'x' }] }],
    });

    expect(result.success).toBe(false);
    expect(firstIssue(result).path).toEqual(['rejected', 0, 'reasons', 0, 'code']);
  });

  test('refuses a rejection with no reason', () => {
    const result = seedRejectedSchema.safeParse({
      generatedAt: GENERATED_AT,
      rejected: [{ candidate: {}, reasons: [] }],
    });

    expect(result.success).toBe(false);
    expect(firstIssue(result).path).toEqual(['rejected', 0, 'reasons']);
  });
});
