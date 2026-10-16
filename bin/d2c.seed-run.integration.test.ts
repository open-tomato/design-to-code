/**
 * Tests for the `seed` verb through {@link run}, over temp copies of the
 * seed fixture exports with a stub {@link AgentSpawner}: the agent is never
 * run.
 *
 * @packageDocumentation
 */

import type { AgentSpawner } from '../pipeline/assess/agent.ts';

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { discover, writeDiscovery } from '../pipeline/assess/discover.ts';
import { readSeedManifest, seedManifestPath, seedRejectedPath } from '../pipeline/seed/files.ts';
import { DISCOVERY_COMMAND } from '../pipeline/seed/run.ts';
import { OS_ASSIGNED_PORT, ServePortError } from '../pipeline/serve/port.ts';

import { run, USAGE } from './d2c';

/** A browser launch plus several page loads with their waits, with room to spare. */
const TEST_TIMEOUT_MS = 60_000;

const SLUG = 'homepage';

/** No `D2C_PORT`; the verb is given the test-only port 0, so the OS assigns the server's port. */
const ENV = { D2C_PROJECT: SLUG };

const FIXTURES = join(import.meta.dirname, '..', 'pipeline', 'seed', 'fixtures');

/** The recorded agent response proposing candidates for both unmarked pages. */
const RECORDED_RESPONSE = readFileSync(join(FIXTURES, 'recorded', 'unmarked-agent.txt'), 'utf8');

let rootDir: string;

/** The project's `source.dir`, absolute under the temporary root. */
function sourceDir(): string {
  return join(rootDir, 'design', SLUG);
}

/** A spawner stub that resolves to `output` and records its calls. */
function stubSpawner(output: string) {
  return vi.fn<AgentSpawner>(async () => output);
}

/** Runs the `seed` verb against the temporary root with `spawnAgent`, on a port the OS assigns. */
function runSeed(args: readonly string[], spawnAgent: AgentSpawner) {
  return run(['seed', ...args], { env: ENV, rootDir, spawnAgent, port: OS_ASSIGNED_PORT });
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'd2c-bin-d2c-seed-test-'));
  cpSync(join(FIXTURES, 'unmarked'), sourceDir(), { recursive: true });
  mkdirSync(join(rootDir, 'projects'), { recursive: true });
  writeFileSync(
    join(rootDir, 'projects', `${SLUG}.json`),
    JSON.stringify({ slug: SLUG, source: { dir: `design/${SLUG}` } }),
  );
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('run seed', () => {
  test('an unknown option is a usage error with exit 1 and never runs the agent', async () => {
    const spawn = stubSpawner(RECORDED_RESPONSE);
    const result = await runSeed(['--scripts-only'], spawn);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^d2c seed: .*'--scripts-only'/);
    expect(result.stderr).toContain(USAGE);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('a positional argument is a usage error with exit 1', async () => {
    const result = await runSeed(['now'], stubSpawner(RECORDED_RESPONSE));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^d2c seed: .*'now'/);
  });

  test('a missing discovery.json is refused naming the assess command, with nothing written', async () => {
    const spawn = stubSpawner(RECORDED_RESPONSE);
    const result = await runSeed([], spawn);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^d2c seed: cannot read /);
    expect(result.stderr).toContain(`run \`${DISCOVERY_COMMAND}\` first`);
    expect(result.stderr.endsWith('\n')).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(seedManifestPath(sourceDir()))).toBe(false);
    expect(existsSync(seedRejectedPath(sourceDir()))).toBe(false);
  });

  test('a stub spawner run over the unmarked fixture prints the counts and both files', async () => {
    writeDiscovery(sourceDir(), discover(sourceDir()));
    const spawn = stubSpawner(RECORDED_RESPONSE);

    const result = await runSeed([], spawn);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `d2c seed: 5 entries, 5 rejected; wrote design/${SLUG}/seed-manifest.json `
        + `and design/${SLUG}/seed-rejected.json\n`,
      stderr: '',
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(readSeedManifest(sourceDir()).components).toHaveLength(5);
    expect(JSON.parse(readFileSync(seedRejectedPath(sourceDir()), 'utf8')).rejected).toHaveLength(5);
  }, TEST_TIMEOUT_MS);

  test('the test-only port reaches the server and outranks a refused D2C_PORT', async () => {
    writeDiscovery(sourceDir(), discover(sourceDir()));
    const env = { ...ENV, D2C_PORT: 'not-a-port' };

    // Control: without the port, the refused D2C_PORT reaches the server, and the verb lets it propagate.
    await expect(run(['seed'], { env, rootDir, spawnAgent: stubSpawner(RECORDED_RESPONSE) }))
      .rejects.toThrow(new ServePortError('D2C_PORT must be an integer from 1 to 65535, got "not-a-port"'));

    const result = await run(['seed'], { env, rootDir, spawnAgent: stubSpawner(RECORDED_RESPONSE), port: OS_ASSIGNED_PORT });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(readSeedManifest(sourceDir()).components).toHaveLength(5);
  }, TEST_TIMEOUT_MS);

  test('an agent answer with no components object is printed as d2c seed: with exit 1', async () => {
    writeDiscovery(sourceDir(), discover(sourceDir()));

    const result = await runSeed([], stubSpawner('no JSON here'));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^d2c seed: /);
    expect(existsSync(seedManifestPath(sourceDir()))).toBe(false);
  }, TEST_TIMEOUT_MS);
});
