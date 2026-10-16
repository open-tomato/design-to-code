/**
 * The `seed` verb: `d2c seed`.
 *
 * It loads the active project's config and runs the seed run
 * (`pipeline/seed/run.ts`) over its `source.dir` with the config's `pages`
 * and the injected {@link AgentSpawner} (`claude -p` from the CLI), which
 * writes `<source.dir>/seed-manifest.json` and
 * `<source.dir>/seed-rejected.json`. The seed run owns the server and the
 * browser; this verb only loads config, calls it and turns refusals into
 * output. `D2C_PORT` is read from the loader's environment.
 *
 * @packageDocumentation
 */

import type { CliResult } from './result.ts';
import type { LoadOptions } from '../../config/load.ts';
import type { AgentSpawner } from '../../pipeline/assess/agent.ts';
import type { RunSeedResult } from '../../pipeline/seed/run.ts';

import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadProjectConfig, ProjectConfigError, REPO_ROOT } from '../../config/load.ts';
import { AgentOutputError } from '../../pipeline/assess/agent.ts';
import { SeedFileError, seedManifestPath, seedRejectedPath } from '../../pipeline/seed/files.ts';
import { runSeed as runSeedPipeline, SeedRefusedError } from '../../pipeline/seed/run.ts';

import { isParseArgsError, verbFailure } from './result.ts';
import { AgentSpawnError } from './spawner.ts';

/** The verb's name, as typed on the command line and printed in output. */
const VERB = 'seed';

/** The `seed` verb accepts no options. */
export type SeedArguments = Readonly<Record<string, never>>;

/** Where the `seed` verb reads the project from, and the port its server binds. */
export interface SeedOptions extends LoadOptions {
  /**
   * A seam for tests, with no CLI flag: the port the server binds, passed
   * to `startServer` as its `port`, so it outranks `D2C_PORT` and never
   * falls back. `0` has the operating system assign a free port. Unset,
   * `D2C_PORT` and then the 4600 range apply.
   */
  readonly port?: number;
}

/**
 * Parses the `seed` verb's arguments; it accepts none.
 *
 * @param args - The arguments after `seed`.
 * @returns An empty flags object, or the usage error's message as a string.
 */
export function parseSeedArguments(args: readonly string[]): SeedArguments | string {
  try {
    parseArgs({ args: [...args], options: {}, strict: true, allowPositionals: false });

    return {};
  } catch (error) {
    if (isParseArgsError(error)) {
      return error.message;
    }

    throw error;
  }
}

/** Whether `error` is one the verb prints rather than propagates. */
function isReportedError(error: unknown): error is Error {
  return error instanceof ProjectConfigError
    || error instanceof SeedRefusedError
    || error instanceof SeedFileError
    || error instanceof AgentSpawnError
    || error instanceof AgentOutputError;
}

/**
 * The one-line summary: entry count, rejection count and both files, each
 * file under `source.dir` as the config gives it.
 */
function summarize(result: RunSeedResult, displayDir: string, sourceDir: string): string {
  const manifest = join(displayDir, basename(seedManifestPath(sourceDir)));
  const rejected = join(displayDir, basename(seedRejectedPath(sourceDir)));

  return `d2c ${VERB}: ${result.manifest.components.length} entries, `
    + `${result.rejected.length} rejected; wrote ${manifest} and ${rejected}\n`;
}

/**
 * The `seed` verb: seeds the active project's component manifest.
 *
 * The config is loaded with `source.dir` required to exist. Only a
 * {@link ProjectConfigError}, a {@link SeedRefusedError} (no
 * `discovery.json`, no kept page, or no accepted entry), a
 * {@link SeedFileError}, an {@link AgentSpawnError} or an
 * {@link AgentOutputError} is turned into output; any other error
 * propagates.
 *
 * @param flags - The parsed flags; there are none.
 * @param options - The environment and root the loader reads from; the
 *   environment also gives the server `D2C_PORT`, unless the test-only
 *   `port` names the port.
 * @param spawn - Runs the agent; called only when a kept page is unmarked.
 * @returns A summary on stdout with exit 0, or the failure as
 *   `d2c seed: <message>` on stderr with exit 1.
 */
export async function runSeed(
  flags: SeedArguments,
  options: SeedOptions,
  spawn: AgentSpawner,
): Promise<CliResult> {
  try {
    const { port, ...loadOptions } = options;
    const rootDir = loadOptions.rootDir ?? REPO_ROOT;
    const config = loadProjectConfig(loadOptions);
    const sourceDir = resolve(rootDir, config.source.dir);
    const result = await runSeedPipeline({ sourceDir, pages: config.pages, spawn, env: loadOptions.env, port });

    return { exitCode: 0, stdout: summarize(result, config.source.dir, sourceDir), stderr: '' };
  } catch (error) {
    if (isReportedError(error)) {
      return verbFailure(VERB, error.message);
    }

    throw error;
  }
}
