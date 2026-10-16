/**
 * Integration test for `d2c gates --local`, over the whole CLI rather than
 * unit by unit: {@link run} is called with the real gate runners, so every
 * gate scans a real library, `tsc` and ESLint run, and the managed Storybook
 * is built and its stories rendered in headless Chromium.
 *
 * Each case copies a fixture library into a folder under the repo's
 * gitignored `.tmp/`, next to a `source/` folder holding the seed manifest,
 * and writes a throwaway, gitignored `projects/<slug>.json` pointing at the
 * copy. The Storybook build reads its project from that file and resolves
 * `react` and the rest from the repo's `node_modules`, which the copy under
 * `.tmp/` finds on its way up. Both are removed afterwards, even if an
 * assertion fails, and the copy keeps `gate-results/` out of the fixtures.
 *
 * Over the passing fixture library the run exits 0 and writes one JSON file
 * per gate per component. Over the failing fixtures it exits 1, and every
 * failing JSON names the rule, file and line of each finding. Over an empty
 * target it exits 1, and every gate reports a `scanned-zero-files` finding.
 *
 * @packageDocumentation
 */

import type { GateName, GateResult } from '../pipeline/gates/result.ts';

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  gateResultPath,
  gateResultSchema,
  GATE_NAMES,
  GATE_RESULTS_DIR,
  LIBRARY_COMPONENT,
  SCANNED_ZERO_FILES_RULE,
} from '../pipeline/gates/result.ts';
import { SEED_COMMAND } from '../pipeline/seed/files.ts';

import { run } from './d2c';

/** The longest a run may take: four gates, one of which builds a Storybook and renders every story. */
const RUN_TIMEOUT_MS = 300_000;

const REPO_ROOT = join(import.meta.dirname, '..');
const FIXTURES = join(REPO_ROOT, 'pipeline', 'gates', 'fixtures');
const PASSING = join(FIXTURES, 'passing');

/** The `tsconfig.json` of a library, which `tsc` needs in `target.dir` and some fixtures leave out. */
const TSCONFIG_FILE = 'tsconfig.json';

/**
 * The rules whose findings carry no line, by design: a missing state story
 * is a story that is not in the file, and a story that errs when rendered
 * is known to the built Storybook by its id, not by a line.
 */
const LINELESS_RULES: ReadonlySet<string> = new Set(['missing-state-story', 'story-renders-clean']);

/** The components the passing fixture library holds, one per level, lowest first. */
const PASSING_COMPONENTS = ['Dot', 'Button', 'Toolbar', 'Header', 'Stack', 'PageLayout'];

/** The seed manifest's file name in `source.dir`. */
const SEED_MANIFEST_FILE = 'seed-manifest.json';

/** A seed manifest naming no component, for libraries whose fixture has no `source/` of its own. */
const EMPTY_MANIFEST = { generatedAt: '2026-01-01T00:00:00.000Z', components: [] };

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

/** A copied library: where it is and the project that points at it. */
interface Sandbox {
  readonly slug: string;
  readonly sourceDir: string;
  readonly targetDir: string;
}

/** What goes into a sandbox: a library to copy and the source folder it is checked against, if any. */
interface SandboxContents {
  /** The folder copied to `target.dir`; the target stays empty when left out. */
  readonly library?: string;
  /** The folder copied to `source.dir`; one holding an empty seed manifest when left out. */
  readonly source?: string;
}

/**
 * Builds a sandbox under `.tmp/` and writes a project config for it, both
 * removed after the test.
 */
function sandbox(label: string, contents: SandboxContents): Sandbox {
  const slug = `integration-gates-${label}-${crypto.randomUUID()}`;
  const root = join(REPO_ROOT, '.tmp', slug);
  const targetDir = join(root, 'library');
  const sourceDir = join(root, 'source');
  const projectFile = join(REPO_ROOT, 'projects', `${slug}.json`);

  created.push(root, projectFile);
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });

  if (contents.library !== undefined) {
    cpSync(contents.library, targetDir, { recursive: true });

    if (!existsSync(join(targetDir, TSCONFIG_FILE))) {
      cpSync(join(PASSING, 'library', TSCONFIG_FILE), join(targetDir, TSCONFIG_FILE));
    }
  }

  if (contents.source === undefined) {
    writeFileSync(join(sourceDir, 'seed-manifest.json'), JSON.stringify(EMPTY_MANIFEST));
  } else {
    cpSync(contents.source, sourceDir, { recursive: true });
  }

  writeFileSync(projectFile, JSON.stringify({
    slug,
    source: { dir: relative(REPO_ROOT, sourceDir) },
    target: { dir: relative(REPO_ROOT, targetDir) },
  }));

  return { slug, sourceDir, targetDir };
}

/** Runs `d2c gates --local` for the sandbox's project, with the real gate runners. */
function runGates(box: Sandbox) {
  return run(['gates', '--local'], { env: { D2C_PROJECT: box.slug } });
}

/** The component folders under `<targetDir>/gate-results/`, sorted. */
function writtenComponents(targetDir: string): readonly string[] {
  const resultsDir = join(targetDir, GATE_RESULTS_DIR);

  return existsSync(resultsDir)
    ? readdirSync(resultsDir).sort()
    : [];
}

/** The JSON file names under one component's results folder, sorted. */
function writtenFiles(targetDir: string, component: string): readonly string[] {
  return readdirSync(join(targetDir, GATE_RESULTS_DIR, component)).sort();
}

/** Every result file the run wrote, parsed against the schema, in component then gate order. */
function readResults(targetDir: string): readonly GateResult[] {
  return writtenComponents(targetDir).flatMap((component) => writtenFiles(targetDir, component)
    .map((file) => gateResultSchema.parse(JSON.parse(readFileSync(join(targetDir, GATE_RESULTS_DIR, component, file), 'utf8')))));
}

/** The failing results among `results`. */
function failing(results: readonly GateResult[]): readonly GateResult[] {
  return results.filter((result) => result.status === 'fail');
}

/** The stdout line the run printed for `gate`, or `undefined` when it printed none. */
function summaryLine(stdout: string, gate: GateName): string | undefined {
  return stdout.split('\n').find((line) => line.startsWith(`d2c gates: ${gate} `));
}

describe('d2c gates --local over the passing fixture library', () => {
  test('exits 0 and writes one JSON file per gate per component', async () => {
    const box = sandbox('passing', { library: join(PASSING, 'library'), source: join(PASSING, 'source') });

    const result = await runGates(box);

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(writtenComponents(box.targetDir)).toEqual([...PASSING_COMPONENTS].sort());

    for (const component of PASSING_COMPONENTS) {
      expect(writtenFiles(box.targetDir, component)).toEqual(GATE_NAMES.map((gate) => `${gate}.json`).sort());
    }

    const results = readResults(box.targetDir);

    expect(results).toHaveLength(PASSING_COMPONENTS.length * GATE_NAMES.length);
    expect(results.filter((each) => each.status !== 'pass')).toEqual([]);
    expect(results.flatMap((each) => each.findings)).toEqual([]);

    for (const gate of GATE_NAMES) {
      expect(summaryLine(result.stdout, gate)).toContain(`${gate} pass`);
    }
  }, RUN_TIMEOUT_MS);

  test('deletes the results folder of a removed component and writes every listed component', async () => {
    const box = sandbox('stale', { library: join(PASSING, 'library'), source: join(PASSING, 'source') });
    const staleDir = join(box.targetDir, GATE_RESULTS_DIR, 'Removed');

    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'structure.json'), '{}');

    const result = await runGates(box);

    expect(result.exitCode).toBe(0);
    expect(existsSync(staleDir)).toBe(false);
    expect(writtenComponents(box.targetDir)).toEqual([...PASSING_COMPONENTS].sort());

    for (const component of PASSING_COMPONENTS) {
      expect(writtenFiles(box.targetDir, component)).toEqual(GATE_NAMES.map((gate) => `${gate}.json`).sort());
    }
  }, RUN_TIMEOUT_MS);
});

/** One failing fixture library and where each gate is expected to fail. */
interface FailingFixture {
  readonly label: string;
  readonly contents: SandboxContents;
  /** The gate whose findings the fixture plants. */
  readonly gate: GateName;
  /** The `[component, rule]` of every finding of that gate, sorted. */
  readonly planted: readonly (readonly [string, string])[];
}

const FAILING_FIXTURES: readonly FailingFixture[] = [
  {
    label: 'structure',
    contents: { library: join(FIXTURES, 'structure', 'layer-imports', 'failing') },
    gate: 'structure',
    planted: [
      ['Button', 'layer-imports'],
      ['Card', 'layer-imports'],
    ],
  },
  {
    label: 'state-coverage',
    contents: {
      library: join(FIXTURES, 'state-coverage', 'failing', 'library'),
      source: join(FIXTURES, 'state-coverage', 'failing', 'source'),
    },
    gate: 'state-coverage',
    planted: [['Button', 'missing-state-story']],
  },
  {
    label: 'build-lint',
    contents: { library: join(FIXTURES, 'build-lint', 'failing', 'library') },
    gate: 'build-lint',
    planted: [
      ['Button', 'd2c/cva-only-classname'],
      ['Button', 'react-hooks/rules-of-hooks'],
      ['Toolbar', 'tsc'],
    ],
  },
  {
    label: 'story-health',
    contents: { library: join(FIXTURES, 'story-health', 'failing', 'library') },
    gate: 'story-health',
    planted: [
      ['Button', 'no-vitest-in-stories'],
      ['Button', 'story-renders-clean'],
      ['Toolbar', 'no-cross-folder-barrel'],
      ['Toolbar', 'no-cross-folder-barrel'],
    ],
  },
];

describe('d2c gates --local over the failing fixtures', () => {
  test.each(FAILING_FIXTURES)('$label: exits 1, naming the rule, file and line of every finding', async ({ label, contents, gate, planted }) => {
    const box = sandbox(label, contents);

    const result = await runGates(box);
    const failed = failing(readResults(box.targetDir));
    const findings = failed.flatMap((each) => each.findings.map((finding) => ({ result: each, finding })));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(gate);
    expect(summaryLine(result.stdout, gate)).toContain(`${gate} fail`);
    expect(failed.length).toBeGreaterThan(0);

    for (const { finding } of findings.filter(({ finding: each }) => each.rule !== SCANNED_ZERO_FILES_RULE)) {
      expect(finding.rule).not.toBe('');
      expect(finding.file).toEqual(expect.stringMatching(/^src\//));

      if (!LINELESS_RULES.has(finding.rule)) {
        expect(finding.line).toEqual(expect.any(Number));
        expect(finding.line).toBeGreaterThanOrEqual(1);
      }

      expect(existsSync(join(box.targetDir, finding.file ?? ''))).toBe(true);
    }

    const plantedFound = findings
      .filter(({ result: each }) => each.gate === gate)
      .map(({ result: each, finding }) => [each.component, finding.rule]);

    expect(plantedFound.sort()).toEqual([...planted].sort());
  }, RUN_TIMEOUT_MS);
});

describe('d2c gates --local over an empty target', () => {
  test('exits 1, every gate failing with a scanned-zero-files finding', async () => {
    const box = sandbox('empty', {});

    const result = await runGates(box);
    const results = readResults(box.targetDir);

    expect(result.exitCode).toBe(1);
    expect(writtenComponents(box.targetDir)).toEqual([LIBRARY_COMPONENT]);

    for (const gate of GATE_NAMES) {
      const written = results.find((each) => each.gate === gate);

      expect(existsSync(gateResultPath(box.targetDir, LIBRARY_COMPONENT, gate))).toBe(true);
      expect(written?.status).toBe('fail');
      expect(written?.findings.map((finding) => finding.rule)).toEqual([SCANNED_ZERO_FILES_RULE]);
      expect(summaryLine(result.stdout, gate)).toContain(`${gate} fail`);
    }
  }, RUN_TIMEOUT_MS);
});

describe('d2c gates --local over a source folder with no seed manifest', () => {
  test('exits 1 with the refusal on stderr and every other gate summarized', async () => {
    const box = sandbox('no-manifest', {});
    const manifestPath = join(box.sourceDir, SEED_MANIFEST_FILE);

    rmSync(manifestPath);

    const result = await runGates(box);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('d2c gates: ');
    expect(result.stderr).toContain(manifestPath);
    expect(result.stderr).toContain(SEED_COMMAND);
    expect(result.stderr).not.toMatch(/\n\s+at /);

    for (const gate of ['structure', 'build-lint', 'story-health'] as const) {
      expect(summaryLine(result.stdout, gate)).toContain(`${gate} fail`);
    }

    expect(summaryLine(result.stdout, 'state-coverage')).toBeUndefined();
  }, RUN_TIMEOUT_MS);
});
