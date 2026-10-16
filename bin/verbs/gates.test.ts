/**
 * Tests for the `gates` verb, both directly and through {@link run}, over
 * a temporary project root with stub gate runners: no gate reads a library,
 * builds Storybook or launches a browser.
 *
 * @packageDocumentation
 */

import type { GateContext, GateOutcome, GateRunner, GateRunners } from './gates.ts';
import type { GateName } from '../../pipeline/gates/result.ts';

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { GATE_NAMES } from '../../pipeline/gates/result.ts';
import { SeedFileError } from '../../pipeline/seed/files.ts';
import { run, USAGE } from '../d2c.ts';

import { LOCAL_GATE_RUNNERS, LOCAL_REQUIRED_MESSAGE, parseGatesArguments, runGates } from './gates.ts';

const SLUG = 'homepage';

const ENV = { D2C_PROJECT: SLUG };

/** The levels the test project's config names, in place of the defaults. */
const LEVELS = ['atoms', 'molecules'];

let rootDir: string;

/** The project's `target.dir`, absolute under the temporary root. */
function targetDir(): string {
  return join(rootDir, 'components', SLUG);
}

/** A passing outcome with one result for `gate`. */
function passing(gate: GateName): GateOutcome {
  return {
    status: 'pass',
    results: [{ gate, component: 'Button', status: 'pass', findings: [], durationMs: 1 }],
    scannedFiles: 3,
  };
}

/** A failing outcome for `gate`: one failing result with two findings, one passing result. */
function failing(gate: GateName): GateOutcome {
  const finding = { rule: 'some-rule', file: 'src/atoms/Card/Card.tsx', line: 4, message: 'wrong' };

  return {
    status: 'fail',
    results: [
      { gate, component: 'Button', status: 'pass', findings: [], durationMs: 1 },
      { gate, component: 'Card', status: 'fail', findings: [finding, { ...finding, line: 9 }], durationMs: 1 },
    ],
    scannedFiles: 3,
  };
}

/** Stub runners, each answering with `outcome(gate)` and recording its calls. */
function stubRunners(outcome: (gate: GateName) => GateOutcome = passing) {
  const entries = GATE_NAMES.map((gate) => [gate, vi.fn<GateRunner>(() => outcome(gate))] as const);

  return Object.fromEntries(entries) as Record<GateName, ReturnType<typeof vi.fn<GateRunner>>>;
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'd2c-bin-verbs-gates-test-'));
  mkdirSync(join(rootDir, 'design', SLUG), { recursive: true });
  mkdirSync(targetDir(), { recursive: true });
  mkdirSync(join(rootDir, 'projects'), { recursive: true });
  writeFileSync(
    join(rootDir, 'projects', `${SLUG}.json`),
    JSON.stringify({ slug: SLUG, source: { dir: `design/${SLUG}` }, levels: LEVELS }),
  );
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('parseGatesArguments', () => {
  test('accepts --local', () => {
    expect(parseGatesArguments(['--local'])).toEqual({ local: true });
  });

  test('refuses no argument with a message naming --local', () => {
    const parsed = parseGatesArguments([]);

    expect(parsed).toBe(LOCAL_REQUIRED_MESSAGE);
    expect(parsed).toContain('--local');
  });

  test('refuses --no-local', () => {
    expect(parseGatesArguments(['--no-local'])).toBeTypeOf('string');
  });

  test('refuses an unknown option', () => {
    expect(parseGatesArguments(['--local', '--ci'])).toContain('--ci');
  });

  test('refuses a positional argument', () => {
    expect(parseGatesArguments(['--local', 'structure'])).toContain('structure');
  });
});

describe('LOCAL_GATE_RUNNERS', () => {
  test('holds one runner per gate name, in gate order', () => {
    expect(Object.keys(LOCAL_GATE_RUNNERS)).toEqual([...GATE_NAMES]);
  });
});

describe('runGates', () => {
  test('runs every gate in order and exits 0 with one summary line per gate when all pass', async () => {
    const calls: string[] = [];
    const runners = stubRunners((gate) => {
      calls.push(gate);

      return passing(gate);
    });

    const result = await runGates({ local: true }, { env: ENV, rootDir }, runners);

    expect(calls).toEqual(['structure', 'state-coverage', 'build-lint', 'story-health']);
    expect(result).toEqual({
      exitCode: 0,
      stdout: [
        'd2c gates: structure pass (1 result, 3 files scanned)',
        'd2c gates: state-coverage pass (1 result, 3 files scanned)',
        'd2c gates: build-lint pass (1 result, 3 files scanned)',
        'd2c gates: story-health pass (1 result, 3 files scanned)',
        '',
      ].join('\n'),
      stderr: '',
    });
  });

  test('hands every runner the project slug, absolute source and target dirs, and the levels', async () => {
    const runners = stubRunners();

    await runGates({ local: true }, { env: ENV, rootDir }, runners);

    const expected: GateContext = {
      project: SLUG,
      sourceDir: join(rootDir, 'design', SLUG),
      targetDir: targetDir(),
      levels: LEVELS,
    };

    for (const gate of GATE_NAMES) {
      expect(runners[gate]).toHaveBeenCalledTimes(1);
      expect(runners[gate]).toHaveBeenCalledWith(expected);
    }
  });

  test('runs every later gate when an early one fails, and exits 1 naming the failed gates', async () => {
    const runners = stubRunners((gate) => gate === 'structure' || gate === 'build-lint'
      ? failing(gate)
      : passing(gate));

    const result = await runGates({ local: true }, { env: ENV, rootDir }, runners);

    for (const gate of GATE_NAMES) {
      expect(runners[gate]).toHaveBeenCalledTimes(1);
    }

    expect(result.exitCode).toBe(1);
    expect(result.stdout.split('\n')).toEqual([
      'd2c gates: structure fail (1 of 2 results failed, 2 findings, 3 files scanned)',
      'd2c gates: state-coverage pass (1 result, 3 files scanned)',
      'd2c gates: build-lint fail (1 of 2 results failed, 2 findings, 3 files scanned)',
      'd2c gates: story-health pass (1 result, 3 files scanned)',
      '',
    ]);
    expect(result.stderr).toBe('d2c gates: 2 of 4 gates failed: structure, build-lint\n');
  });

  test('starts each gate only once the one before it has finished', async () => {
    const events: string[] = [];
    const slowRunner = (gate: GateName): GateRunner => async () => {
      events.push(`start ${gate}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      events.push(`end ${gate}`);

      return passing(gate);
    };
    const runners: GateRunners = {
      'structure': slowRunner('structure'),
      'state-coverage': slowRunner('state-coverage'),
      'build-lint': slowRunner('build-lint'),
      'story-health': slowRunner('story-health'),
    };

    await runGates({ local: true }, { env: ENV, rootDir }, runners);

    expect(events).toEqual(GATE_NAMES.flatMap((gate) => [`start ${gate}`, `end ${gate}`]));
  });

  test('refuses a missing target.dir with exit 1, running no gate', async () => {
    rmSync(targetDir(), { recursive: true });
    const runners = stubRunners();

    const result = await runGates({ local: true }, { env: ENV, rootDir }, runners);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `d2c gates: target.dir: 'components/${SLUG}' does not exist (${targetDir()})\n`,
    });
    for (const gate of GATE_NAMES) {
      expect(runners[gate]).not.toHaveBeenCalled();
    }
  });

  test('refuses a target.dir that is a file with exit 1, running no gate', async () => {
    rmSync(targetDir(), { recursive: true });
    writeFileSync(targetDir(), '');
    const runners = stubRunners();

    const result = await runGates({ local: true }, { env: ENV, rootDir }, runners);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(`d2c gates: target.dir: 'components/${SLUG}' is not a directory (${targetDir()})\n`);
    expect(runners.structure).not.toHaveBeenCalled();
  });

  test('runs the gates over an empty target.dir rather than refusing', async () => {
    const runners = stubRunners();

    const result = await runGates({ local: true }, { env: ENV, rootDir }, runners);

    expect(result.exitCode).toBe(0);
    expect(runners.structure).toHaveBeenCalledTimes(1);
  });

  test('removes a stale gate-results folder before any runner is called, keeping listed components and _library', async () => {
    const resultsDir = join(targetDir(), 'gate-results');

    mkdirSync(join(targetDir(), 'src', 'atoms', 'Button'), { recursive: true });
    writeFileSync(join(targetDir(), 'src', 'atoms', 'Button', 'Button.tsx'), '');
    for (const name of ['Button', 'Removed', '_library']) {
      mkdirSync(join(resultsDir, name), { recursive: true });
      writeFileSync(join(resultsDir, name, 'structure.json'), '{}');
    }
    const seen: string[] = [];
    const runners = stubRunners();

    runners.structure.mockImplementation(() => {
      seen.push(...['Button', 'Removed', '_library'].filter((name) => existsSync(join(resultsDir, name))));

      return passing('structure');
    });

    const result = await runGates({ local: true }, { env: ENV, rootDir }, runners);

    expect(result.exitCode).toBe(0);
    expect(runners.structure).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['Button', '_library']);
  });

  test('refuses a config failure with exit 1, running no gate', async () => {
    const runners = stubRunners();

    const result = await runGates({ local: true }, { env: {}, rootDir }, runners);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^d2c gates: D2C_PROJECT is not set/);
    expect(runners.structure).not.toHaveBeenCalled();
  });

  test('refuses only the gate that throws a SeedFileError, running and summarizing every other gate', async () => {
    const stubs = stubRunners();
    const refusing = vi.fn<GateRunner>(() => {
      throw new SeedFileError('/x/seed-manifest.json', 'no seed manifest; run `bun run d2c seed` to write it');
    });
    const runners = { ...stubs, 'state-coverage': refusing };

    const result = await runGates({ local: true }, { env: ENV, rootDir }, runners);

    expect(refusing).toHaveBeenCalledTimes(1);
    expect(stubs.structure).toHaveBeenCalledTimes(1);
    expect(stubs['build-lint']).toHaveBeenCalledTimes(1);
    expect(stubs['story-health']).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      exitCode: 1,
      stdout: [
        'd2c gates: structure pass (1 result, 3 files scanned)',
        'd2c gates: build-lint pass (1 result, 3 files scanned)',
        'd2c gates: story-health pass (1 result, 3 files scanned)',
        '',
      ].join('\n'),
      stderr: 'd2c gates: /x/seed-manifest.json: no seed manifest; run `bun run d2c seed` to write it\n',
    });
  });

  test('refuses a gate whose runner rejects with a SeedFileError', async () => {
    const runners = {
      ...stubRunners(),
      'state-coverage': () => Promise.reject(new SeedFileError('/x/seed-manifest.json', 'not valid JSON')),
    };

    const result = await runGates({ local: true }, { env: ENV, rootDir }, runners);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.split('\n')).toHaveLength(4);
    expect(result.stderr).toBe('d2c gates: /x/seed-manifest.json: not valid JSON\n');
  });

  test('prints a refusal before the failed gates, counting only the gates that reached an outcome', async () => {
    const runners = {
      ...stubRunners((gate) => gate === 'build-lint'
        ? failing(gate)
        : passing(gate)),
      'state-coverage': () => {
        throw new SeedFileError('/x/seed-manifest.json', 'not valid JSON');
      },
    };

    const result = await runGates({ local: true }, { env: ENV, rootDir }, runners);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('d2c gates: build-lint fail (1 of 2 results failed, 2 findings, 3 files scanned)\n');
    expect(result.stderr).toBe([
      'd2c gates: /x/seed-manifest.json: not valid JSON',
      'd2c gates: 1 of 3 gates failed: build-lint',
      '',
    ].join('\n'));
  });

  test('lets any other error a gate throws propagate', async () => {
    const runners = {
      ...stubRunners(),
      'build-lint': () => Promise.reject(new Error('tsc could not start')),
    };

    await expect(runGates({ local: true }, { env: ENV, rootDir }, runners)).rejects.toThrow('tsc could not start');
  });
});

describe('the gates verb through run', () => {
  test('is a usage error naming --local without it, running no gate', async () => {
    const gateRunners = stubRunners();

    const result = await run(['gates'], { env: ENV, rootDir, gateRunners });

    expect(result).toEqual({ exitCode: 1, stdout: '', stderr: `d2c gates: ${LOCAL_REQUIRED_MESSAGE}\n\n${USAGE}\n` });
    expect(gateRunners.structure).not.toHaveBeenCalled();
  });

  test('runs the injected gate runners with --local', async () => {
    const gateRunners = stubRunners((gate) => gate === 'story-health'
      ? failing(gate)
      : passing(gate));

    const result = await run(['gates', '--local'], { env: ENV, rootDir, gateRunners });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('d2c gates: 1 of 4 gates failed: story-health\n');
  });

  test('is listed in the usage text with --local', () => {
    expect(USAGE).toMatch(/^ {2}gates {3}/m);
    expect(USAGE).toContain('--local');
  });
});
