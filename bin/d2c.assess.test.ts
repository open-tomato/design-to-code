import type { AgentSpawner } from '../pipeline/assess/agent.ts';
import type { AgentNotes, DiscoveryReport } from '../pipeline/assess/schema.ts';

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { discoveryPath } from '../pipeline/assess/discover.ts';
import { discoveryReportSchema, emptyAgentNotes, SCRIPT_FIELDS } from '../pipeline/assess/schema.ts';

import { run, USAGE } from './d2c';
import { AgentSpawnError } from './verbs/spawner.ts';

const SLUG = 'homepage';

const ENV = { D2C_PROJECT: SLUG };

let rootDir: string;

/** Writes `projects/<slug>.json` under the temporary root. */
function writeProject(content: unknown): void {
  mkdirSync(join(rootDir, 'projects'), { recursive: true });
  writeFileSync(join(rootDir, 'projects', `${SLUG}.json`), JSON.stringify(content));
}

describe('run assess', () => {
  const FIXTURE = join(import.meta.dirname, '..', 'pipeline', 'assess', 'fixtures', 'without-ds');

  const NOTES: AgentNotes = {
    pageRoles: { 'about.html': { role: 'other', reason: 'a plain content page' } },
    versionGroups: [],
    boundaryHints: [{ page: 'index.html', selector: 'header.site-header', note: 'the site header' }],
  };

  /** The project's `source.dir`, absolute under the temporary root. */
  function sourceDir(): string {
    return join(rootDir, 'design', SLUG);
  }

  /** The discovery report on disk, validated against the schema. */
  function readReport() {
    return discoveryReportSchema.parse(JSON.parse(readFileSync(discoveryPath(sourceDir()), 'utf8')));
  }

  /** The report's script fields, without `generatedAt` or `agentNotes`. */
  function scriptFieldsOf(report: DiscoveryReport) {
    return Object.fromEntries(SCRIPT_FIELDS.map((field) => [field, report[field]]));
  }

  /** A spawner stub that records its prompt and resolves to `output`. */
  function stubSpawner(output: string) {
    return vi.fn<AgentSpawner>(async () => output);
  }

  /** Runs the `assess` verb against the temporary root with `spawnAgent`. */
  function runAssess(
    args: readonly string[],
    spawnAgent: AgentSpawner,
    env: Record<string, string | undefined> = ENV,
  ) {
    return run(['assess', ...args], { env, rootDir, spawnAgent });
  }

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'd2c-bin-d2c-assess-test-'));
    cpSync(FIXTURE, sourceDir(), { recursive: true });
    writeProject({ slug: SLUG, source: { dir: `design/${SLUG}` } });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test('writes the scripts\' report with --scripts-only and never runs the agent', async () => {
    const spawn = stubSpawner(JSON.stringify({ agentNotes: NOTES }));
    const result = await runAssess(['--scripts-only'], spawn);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `d2c assess: 2 pages, 1 token files, 0 variant maps; wrote design/${SLUG}/discovery.json (scripts only)\n`,
      stderr: '',
    });
    expect(spawn).not.toHaveBeenCalled();

    const report = readReport();

    expect(report.pages.map((page) => page.path)).toEqual(['about.html', 'index.html']);
    expect(report.agentNotes).toEqual(emptyAgentNotes());
  });

  test('runs the agent once without --scripts-only and writes its notes', async () => {
    const spawn = stubSpawner(`Here are the notes:\n${JSON.stringify({ agentNotes: NOTES })}\n`);
    const result = await runAssess([], spawn);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `d2c assess: 2 pages, 1 token files, 0 variant maps; wrote design/${SLUG}/discovery.json (agent notes merged)\n`,
      stderr: '',
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toContain('# Agent Prompt: Assess Design Export');
    expect(spawn.mock.calls[0]?.[0]).toContain('index.html');
    expect(readReport().agentNotes).toEqual(NOTES);
  });

  test('leaves the script fields as --scripts-only writes them when the agent runs', async () => {
    await runAssess(['--scripts-only'], stubSpawner(''));
    const scripted = scriptFieldsOf(readReport());

    await runAssess([], stubSpawner(JSON.stringify({ agentNotes: NOTES })));

    expect(scriptFieldsOf(readReport())).toEqual(scripted);
  });

  test('refuses agent output that touches a script field, keeping the scripts\' report', async () => {
    const result = await runAssess([], stubSpawner(JSON.stringify({ agentNotes: NOTES, pages: [] })));

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'd2c assess: agent output refused: touches script-owned field pages\n',
    });

    const report = readReport();

    expect(report.pages).toHaveLength(2);
    expect(report.agentNotes).toEqual(emptyAgentNotes());
  });

  test('prints the output error when the agent prints no JSON object and exits 1', async () => {
    const result = await runAssess([], stubSpawner('I could not read the export.'));

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.startsWith('d2c assess: ')).toBe(true);
    expect(result.stderr).toContain('holds no parseable JSON object');
    expect(readReport().agentNotes).toEqual(emptyAgentNotes());
  });

  test('prints a spawn failure and exits 1', async () => {
    const spawn = vi.fn<AgentSpawner>(async () => {
      throw new AgentSpawnError('claude -p: exited with code 2: not logged in');
    });
    const result = await runAssess([], spawn);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'd2c assess: claude -p: exited with code 2: not logged in\n',
    });
    expect(readReport().agentNotes).toEqual(emptyAgentNotes());
  });

  test('propagates an error the spawner throws that is not a spawn failure', async () => {
    const spawn = vi.fn<AgentSpawner>(async () => {
      throw new TypeError('a bug in the spawner');
    });

    await expect(runAssess([], spawn)).rejects.toThrow('a bug in the spawner');
  });

  test('prints the walk\'s refusal of a symlink and writes no report', async () => {
    symlinkSync(join(sourceDir(), 'index.html'), join(sourceDir(), 'linked.html'));
    const spawn = stubSpawner('');
    const result = await runAssess([], spawn);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'd2c assess: linked.html: not a regular file or directory; cannot assess it\n',
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(discoveryPath(sourceDir()))).toBe(false);
  });

  test('prints the walk\'s refusal of a symlink with --scripts-only and writes no report', async () => {
    symlinkSync(join(sourceDir(), 'index.html'), join(sourceDir(), 'linked.html'));
    const spawn = stubSpawner('');
    const result = await runAssess(['--scripts-only'], spawn);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'd2c assess: linked.html: not a regular file or directory; cannot assess it\n',
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(discoveryPath(sourceDir()))).toBe(false);
  });

  test('prints the loader error for a source.dir that does not exist and exits 1', async () => {
    rmSync(sourceDir(), { recursive: true });
    const spawn = stubSpawner('');
    const result = await runAssess(['--scripts-only'], spawn);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`d2c assess: projects/${SLUG}.json: `);
    expect(result.stderr).toContain(`source.dir: 'design/${SLUG}' does not exist`);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('prints the loader error when D2C_PROJECT is unset and exits 1', async () => {
    const result = await runAssess(['--scripts-only'], stubSpawner(''), {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr.startsWith('d2c assess: D2C_PROJECT is not set')).toBe(true);
    expect(existsSync(discoveryPath(sourceDir()))).toBe(false);
  });

  test.each([
    ['an unknown option', ['--all']],
    ['a positional argument', ['extra']],
    ['a value on --scripts-only', ['--scripts-only=yes']],
  ])('treats %s as a usage error and exits 1', async (_label, args) => {
    const spawn = stubSpawner('');
    const result = await runAssess(args, spawn);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.startsWith('d2c assess: ')).toBe(true);
    expect(result.stderr.endsWith(`\n\n${USAGE}\n`)).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(discoveryPath(sourceDir()))).toBe(false);
  });

  test('usage lists the assess verb and its flag', () => {
    expect(USAGE).toContain('  assess  ');
    expect(USAGE).toContain('--scripts-only');
    expect(USAGE).toContain('claude -p');
  });
});
