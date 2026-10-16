import type { AgentNotes, DiscoveryReport, ScriptReport } from './schema.ts';

import { describe, expect, test } from 'vitest';

import { AGENT_OUTPUT_KEY, MergeRefusedError, mergeAgentNotes } from './merge.ts';
import { emptyAgentNotes, KNOWN_FILE_NAMES, SCRIPT_FIELDS } from './schema.ts';

const SCRIPT_REPORT: ScriptReport = {
  generatedAt: '2026-09-30T12:00:00.000Z',
  pages: [
    {
      path: 'landing-v2.dc.html',
      title: 'Landing v2',
      scripts: [{ src: 'support.js', type: null }, { inline: true, type: 'text/babel' }],
      stylesheets: [{ href: 'system/theme.css' }],
      markers: { 'data-dc-component': 3 },
    },
    { path: 'landing.dc.html', title: 'Landing', scripts: [], stylesheets: [], markers: {} },
  ],
  tokens: [{ path: 'system/theme.css', customPropertyCount: 4 }],
  variantMaps: [{ path: 'system/variants.ts' }],
  assets: {
    images: [],
    fonts: [],
    styles: ['system/theme.css'],
    scripts: ['support.js'],
    other: [],
  },
  knownFiles: KNOWN_FILE_NAMES.map((name) => (name === 'support.js'
    ? { name, status: 'found' as const, paths: ['support.js'] }
    : { name, status: 'absent' as const, paths: [] })),
};

/** The report as `discover` hands it over: script fields plus empty notes. */
const SCRIPTS_ONLY: DiscoveryReport = { ...SCRIPT_REPORT, agentNotes: emptyAgentNotes() };

const NOTES: AgentNotes = {
  pageRoles: { 'landing.dc.html': { role: 'early-version', reason: 'older copy of landing-v2' } },
  versionGroups: [['landing-v2.dc.html', 'landing.dc.html']],
  boundaryHints: [{ page: 'landing-v2.dc.html', marker: 'data-dc-component', note: 'one per component' }],
};

/** The refusal `mergeAgentNotes` throws for `output`, failing when it accepts. */
function refusal(output: unknown): MergeRefusedError {
  try {
    mergeAgentNotes(SCRIPTS_ONLY, output);
  } catch (error) {
    if (error instanceof MergeRefusedError) {
      return error;
    }

    throw error;
  }

  throw new Error(`expected ${JSON.stringify(output)} to be refused`);
}

describe('mergeAgentNotes refuses', () => {
  test.each([
    ['null', null],
    ['an array', [NOTES]],
    ['a string', JSON.stringify({ agentNotes: NOTES })],
    ['a number', 1],
  ])('output that is %s, not an object', (_label, output) => {
    const error = refusal(output);

    expect(error.fields).toEqual(['']);
    expect(error.message).toContain('must be a JSON object');
  });

  test.each([...SCRIPT_FIELDS, 'generatedAt' as const])('output restating the script-owned %s, even unchanged', (field) => {
    const error = refusal({ agentNotes: NOTES, [field]: SCRIPT_REPORT[field] });

    expect(error.fields).toEqual([field]);
    expect(error.message).toContain(`script-owned field ${field}`);
  });

  test('output rewriting a script-owned field, naming it', () => {
    const error = refusal({ agentNotes: NOTES, pages: [] });

    expect(error.fields).toEqual(['pages']);
  });

  test('output carrying an unknown top-level key, naming it', () => {
    const error = refusal({ agentNotes: NOTES, readiness: 0.9 });

    expect(error.fields).toEqual(['readiness']);
    expect(error.message).toContain('unknown top-level key readiness');
  });

  test('a __proto__ key parsed from JSON as an unknown key', () => {
    const output: unknown = JSON.parse(`{"agentNotes":${JSON.stringify(NOTES)},"__proto__":{"pages":[]}}`);

    expect(refusal(output).fields).toEqual(['__proto__']);
  });

  test('every offending key at once, script-owned first, each group sorted', () => {
    const error = refusal({ agentNotes: NOTES, zeta: 1, tokens: [], alpha: 2, assets: {} });

    expect(error.fields).toEqual(['assets', 'tokens', 'alpha', 'zeta']);
  });

  test('output with no agentNotes', () => {
    expect(refusal({}).fields).toEqual([AGENT_OUTPUT_KEY]);
  });

  test('bare agentNotes, not wrapped under the agentNotes key', () => {
    expect(refusal(NOTES).fields).toEqual(['boundaryHints', 'pageRoles', 'versionGroups']);
  });

  test('agentNotes that fail their schema, naming the failing path', () => {
    const notes = { ...NOTES, pageRoles: { 'landing.dc.html': { role: 'hero', reason: 'x' } } };

    expect(refusal({ agentNotes: notes }).fields).toEqual(['agentNotes.pageRoles.landing.dc.html.role']);
  });

  test('agentNotes smuggling a script-owned field inside them', () => {
    expect(refusal({ agentNotes: { ...NOTES, pages: [] } }).fields).toEqual(['agentNotes']);
  });

  test('a script report that is itself invalid, with a plain ZodError', () => {
    const report = { ...SCRIPTS_ONLY, pages: [...SCRIPTS_ONLY.pages].reverse() };

    expect(() => mergeAgentNotes(report, { agentNotes: NOTES })).toThrow(/sorted/);
    expect(() => mergeAgentNotes(report, { agentNotes: NOTES })).not.toThrow(MergeRefusedError);
  });

  test('an invalid script report before judging the output', () => {
    const report = { ...SCRIPTS_ONLY, generatedAt: 'yesterday' };

    expect(() => mergeAgentNotes(report, null)).toThrow(/generatedAt/);
    expect(() => mergeAgentNotes(report, null)).not.toThrow(MergeRefusedError);
  });
});

describe('mergeAgentNotes accepts', () => {
  test('output holding only agentNotes, returning the script fields unchanged', () => {
    const merged = mergeAgentNotes(SCRIPTS_ONLY, { agentNotes: NOTES });

    expect(merged).toStrictEqual({ ...SCRIPT_REPORT, agentNotes: NOTES });
  });

  test('a bare script report with no agentNotes of its own', () => {
    expect(mergeAgentNotes(SCRIPT_REPORT, { agentNotes: NOTES })).toStrictEqual({ ...SCRIPT_REPORT, agentNotes: NOTES });
  });

  test('replacing earlier agentNotes rather than merging into them', () => {
    const earlier = { ...SCRIPT_REPORT, agentNotes: NOTES };

    expect(mergeAgentNotes(earlier, { agentNotes: emptyAgentNotes() }).agentNotes).toStrictEqual(emptyAgentNotes());
  });

  test('without mutating the report or the output, and sharing no objects with either', () => {
    const report = structuredClone(SCRIPTS_ONLY);
    const output = { agentNotes: structuredClone(NOTES) };

    const merged = mergeAgentNotes(report, output);

    expect(report).toStrictEqual(SCRIPTS_ONLY);
    expect(output).toStrictEqual({ agentNotes: NOTES });
    expect(merged.pages).not.toBe(report.pages);
    expect(merged.agentNotes).not.toBe(output.agentNotes);
  });
});
