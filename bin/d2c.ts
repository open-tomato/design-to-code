/**
 * Interim entry point of the design-to-code tool, run as
 * `bun run d2c <verb>`.
 *
 * `d2c`, `d2c help`, `d2c -h` and `d2c --help` print the usage text and
 * exit 0. `d2c config` loads the active project's config and prints it as
 * JSON with every default filled in, exiting 0; if the config cannot be
 * loaded it prints the loader's error, which names the failing field, to
 * stderr and exits 1. Any other argument is an unknown verb, which prints an
 * error and the usage text to stderr and exits 1.
 *
 * `d2c import --source=<path> [--force]` imports a folder or a `.zip` into
 * the active project's `source.dir`, which need not exist yet, and writes
 * the import record; it prints a one-line summary and exits 0. A missing or
 * empty `--source`, or an option it does not know, is a usage error with
 * exit 1. A config or import failure is printed as `d2c import: <message>`
 * on stderr with exit 1.
 *
 * `d2c assess [--scripts-only]` runs the discovery scripts over the active
 * project's `source.dir` and writes `discovery.json`; without
 * `--scripts-only` it then runs the assess agent with `claude -p` and
 * writes the report again with the agent's notes merged in (see
 * `bin/verbs/assess.ts`). An option it does not know is a usage error with
 * exit 1; a config, discovery, agent or merge failure is printed as
 * `d2c assess: <message>` on stderr with exit 1.
 *
 * `d2c serve [--check]` serves the active project's `source.dir` on
 * `127.0.0.1` with the nav bar and curation (see `bin/verbs/serve.ts`),
 * prints `d2c serve: serving <source.dir> at <address>` and keeps running
 * until SIGINT or SIGTERM, which stop the server and exit 0. With `--check`
 * it starts its own server, loads every kept page headless, writes
 * `<source.dir>/serve-check.json`, stops the server and exits 0 only when no
 * page has a console error, a failed request or a blank render, else 1. An
 * option it does not know is a usage error with exit 1; a config failure, a
 * missing `discovery.json` or an invalid or taken port is printed as
 * `d2c serve: <message>` on stderr with exit 1. `D2C_PORT` names the port;
 * unset, the first free port from 4600 to 4699 is taken.
 *
 * `d2c baseline confirm` asks, for every kept page the share link does not
 * confirm, whether the served page works as in Claude Design, writes the
 * answers to `<baselineDir>/confirmed.json`, and exits 0 only when every
 * kept page is confirmed, else 1 naming the rest. `d2c baseline capture`
 * captures every confirmed kept page twice at every configured viewport,
 * writes the baseline under `<baselineDir>/<playwright version>/<import
 * hash>/`, and exits 0 only when no capture is flaky, else 1 naming each
 * flaky page, viewport and region (see `bin/verbs/baseline.ts`). A missing
 * or unknown subcommand is a usage error with exit 1; a baseline refusal,
 * such as no import record, unset `viewports` or an unconfirmed page, is
 * printed as `d2c baseline: <message>` on stderr with exit 1.
 *
 * `d2c seed` seeds the active project's component manifest (see
 * `bin/verbs/seed.ts`): it serves `source.dir`, reads component markers
 * from every kept page, runs the seed agent once with `claude -p` over the
 * unmarked pages, validates every candidate against its served page, and
 * writes `<source.dir>/seed-manifest.json` and
 * `<source.dir>/seed-rejected.json`. It prints the entry count, the
 * rejection count and both files and exits 0. It takes no option, so any
 * option is a usage error with exit 1; a config failure, a seed refusal
 * (no `discovery.json`, no kept page, no accepted entry), an unreadable
 * seed file, or an agent that fails or answers malformed is printed as
 * `d2c seed: <message>` on stderr with exit 1.
 *
 * `d2c gates --local` runs the local gates over the active project's
 * library at `target.dir`, in order `structure`, `state-coverage`,
 * `build-lint`, `story-health`, every one even when an earlier one fails
 * (see `bin/verbs/gates.ts`). It prints one summary line per gate on stdout
 * and exits 0 only when every gate passed, else 1 with the failed gates
 * named on stderr. Without `--local`, or with an option it does not know,
 * it is a usage error with exit 1; a config failure, a missing `target.dir`
 * or an invalid seed manifest is printed as `d2c gates: <message>` on
 * stderr with exit 1.
 *
 * Exit codes: 0 when the verb succeeded, 1 when it refused (a usage
 * error, a bad config, or an import, assess, serve, baseline, seed or
 * gates refusal) or a gate failed, 2 when it failed unexpectedly.
 * {@link main} turns an error that escapes a verb into one of the last two: an instance of a known refusal class prints
 * `d2c: <message>` on stderr without a stack and exits 1; anything else
 * prints its stack on stderr and exits 2.
 *
 * {@link run} resolves to the output and exit code; it never writes or
 * exits, so tests call it directly and inject a stub spawner, page
 * checker, page opener, prompter or gate runners. A result from `serve` without `--check` carries a `stop` handle
 * for the server still running. {@link main} wraps `run` for the
 * `import.meta.main` block: it writes the result through injected writers,
 * hands a `stop` handle on, and returns the exit code.
 *
 * @packageDocumentation
 */

import type { BaselinePrompter } from './verbs/baseline.ts';
import type { GateRunners } from './verbs/gates.ts';
import type { CliResult } from './verbs/result.ts';
import type { PageChecker } from './verbs/serve.ts';
import type { LoadOptions } from '../config/load';
import type { AgentSpawner } from '../pipeline/assess/agent.ts';
import type { PageOpener } from '../pipeline/baseline/confirm.ts';

import { ProjectConfigError } from '../config/load';
import { AgentOutputError } from '../pipeline/assess/agent.ts';
import { AssessRefusedError } from '../pipeline/assess/errors.ts';
import { MergeRefusedError } from '../pipeline/assess/merge.ts';
import { ConfirmRefusedError } from '../pipeline/baseline/confirm.ts';
import { ConfirmedFileError } from '../pipeline/baseline/confirmed.ts';
import { BaselinePathError, MissingImportRecordError } from '../pipeline/baseline/key.ts';
import { CaptureRefusedError } from '../pipeline/baseline/run-capture.ts';
import { ImportError } from '../pipeline/import/index.ts';
import { ZipError } from '../pipeline/import/zip.ts';
import { SeedFileError } from '../pipeline/seed/files.ts';
import { SeedRefusedError } from '../pipeline/seed/run.ts';
import { checkPages } from '../pipeline/serve/check.ts';
import { ServePortError } from '../pipeline/serve/port.ts';

import { parseAssessArguments, runAssess } from './verbs/assess.ts';
import { headedPageOpener, parseBaselineArguments, readlinePrompter, runBaseline } from './verbs/baseline.ts';
import { runConfig } from './verbs/config.ts';
import { LOCAL_GATE_RUNNERS, parseGatesArguments, runGates } from './verbs/gates.ts';
import { parseImportArguments, runImport } from './verbs/import.ts';
import { parseSeedArguments, runSeed } from './verbs/seed.ts';
import { MissingDiscoveryError, parseServeArguments, runServe } from './verbs/serve.ts';
import { AgentSpawnError, claudeSpawner } from './verbs/spawner.ts';
import { HELP_ARGUMENTS, USAGE } from './verbs/usage.ts';

export type { CliResult } from './verbs/result.ts';
export { USAGE } from './verbs/usage.ts';

/**
 * Where the verbs read the project from, how `assess` runs the agent, how
 * `serve --check` and `baseline confirm` check pages, and how
 * `baseline confirm` opens a page and asks the person about it, and the
 * runners `gates` runs.
 */
export interface CliOptions extends LoadOptions {
  /** Runs the assess and seed agents; {@link claudeSpawner} (`claude -p`) by default. */
  readonly spawnAgent?: AgentSpawner;
  /** Runs `serve --check`'s health check; {@link checkPages} (headless Chromium) by default. */
  readonly checkPages?: PageChecker;
  /** Opens a page for `baseline confirm`; a headed Chromium window by default. */
  readonly openPage?: PageOpener;
  /** Asks the person for `baseline confirm`; a `node:readline` prompt on stdin by default. */
  readonly prompt?: BaselinePrompter;
  /** Runs each gate for `gates`; {@link LOCAL_GATE_RUNNERS} by default. */
  readonly gateRunners?: GateRunners;
  /**
   * A seam for tests, with no CLI flag: the port `serve` and `seed` bind,
   * outranking `D2C_PORT` and never falling back. `0` has the operating
   * system assign a free port. Unset, `D2C_PORT` and then the 4600 range
   * apply.
   */
  readonly port?: number;
}

/** A usage error: the message, the usage text, exit 1. */
function usageError(verb: string, message: string): CliResult {
  return { exitCode: 1, stdout: '', stderr: `d2c ${verb}: ${message}\n\n${USAGE}\n` };
}

/**
 * Resolves the CLI arguments to output and an exit code, without writing
 * anything or exiting.
 *
 * @param args - The arguments after the script name (`process.argv.slice(2)`).
 * @param options - Where the verbs read the project from, the loader's
 *   defaults (`process.env` and the repo root) when left out, the spawner
 *   `assess` and `seed` run the agent with, the checker `serve --check` runs,
 *   the page opener and prompter of `baseline confirm`, the gate runners
 *   of `gates`, and the test-only port of `serve` and `seed`.
 * @returns Usage on stdout with exit 0 for no argument or a help request;
 *   the `config`, `import`, `assess`, `serve`, `baseline`, `seed` or `gates` verb's result for that
 *   verb; an unknown-verb error plus usage on stderr with exit 1 otherwise.
 */
export async function run(args: readonly string[], options: CliOptions = {}): Promise<CliResult> {
  const [verb] = args;
  const {
    spawnAgent = claudeSpawner,
    checkPages: pageChecker = checkPages,
    openPage = headedPageOpener,
    prompt = readlinePrompter,
    gateRunners = LOCAL_GATE_RUNNERS,
    port,
    ...loadOptions
  } = options;

  if (verb === undefined || HELP_ARGUMENTS.has(verb)) {
    return { exitCode: 0, stdout: `${USAGE}\n`, stderr: '' };
  }

  if (verb === 'config') {
    return runConfig(loadOptions);
  }

  if (verb === 'import') {
    const parsed = parseImportArguments(args.slice(1));

    return typeof parsed === 'string'
      ? usageError('import', parsed)
      : runImport(parsed, loadOptions);
  }

  if (verb === 'assess') {
    const parsed = parseAssessArguments(args.slice(1));

    return typeof parsed === 'string'
      ? usageError('assess', parsed)
      : runAssess(parsed, loadOptions, spawnAgent);
  }

  if (verb === 'serve') {
    const parsed = parseServeArguments(args.slice(1));

    return typeof parsed === 'string'
      ? usageError('serve', parsed)
      : runServe(parsed, { ...loadOptions, checkPages: pageChecker, port });
  }

  if (verb === 'baseline') {
    const parsed = parseBaselineArguments(args.slice(1));

    return typeof parsed === 'string'
      ? usageError('baseline', parsed)
      : runBaseline(parsed, { ...loadOptions, checkPages: pageChecker, openPage, prompt });
  }

  if (verb === 'seed') {
    const parsed = parseSeedArguments(args.slice(1));

    return typeof parsed === 'string'
      ? usageError('seed', parsed)
      : runSeed(parsed, { ...loadOptions, port }, spawnAgent);
  }

  if (verb === 'gates') {
    const parsed = parseGatesArguments(args.slice(1));

    return typeof parsed === 'string'
      ? usageError('gates', parsed)
      : runGates(parsed, loadOptions, gateRunners);
  }

  return {
    exitCode: 1,
    stdout: '',
    stderr: `d2c: unknown verb '${verb}'\n\n${USAGE}\n`,
  };
}

/** The signals that stop a server `serve` left running. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Stops `stop`'s server on the first SIGINT or SIGTERM, then exits 0, or 1
 * with the error on stderr when stopping fails.
 */
function stopOnSignal(stop: () => Promise<void>): void {
  const shutdown = (): void => {
    for (const signal of STOP_SIGNALS) {
      process.off(signal, shutdown);
    }

    stop().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`d2c serve: stopping the server failed: ${String(error)}\n`);
        process.exit(1);
      },
    );
  };

  for (const signal of STOP_SIGNALS) {
    process.on(signal, shutdown);
  }
}

/** The exit code {@link main} returns for a known refusal that escaped a verb. */
const REFUSAL_EXIT_CODE = 1;

/** The exit code {@link main} returns for any other error that escaped a verb. */
const UNEXPECTED_EXIT_CODE = 2;

/**
 * The error classes whose instances are refusals, not bugs: their message
 * is meant for the user and their stack is not.
 */
const REFUSAL_CLASSES: readonly (abstract new (...args: never[]) => Error)[] = [
  ImportError,
  ZipError,
  MergeRefusedError,
  ProjectConfigError,
  AgentSpawnError,
  AssessRefusedError,
  AgentOutputError,
  MissingDiscoveryError,
  ServePortError,
  MissingImportRecordError,
  ConfirmedFileError,
  ConfirmRefusedError,
  CaptureRefusedError,
  BaselinePathError,
  SeedRefusedError,
  SeedFileError,
];

/** Whether `error` is an instance of one of {@link REFUSAL_CLASSES}. */
function isRefusal(error: unknown): error is Error {
  return REFUSAL_CLASSES.some((refusalClass) => error instanceof refusalClass);
}

/** How a thrown value that is not a refusal is printed: its stack, else its string form. */
function describeUnexpected(error: unknown): string {
  return error instanceof Error
    ? error.stack ?? `${error.name}: ${error.message}`
    : String(error);
}

/** Where {@link main} writes a result and hands a running server's `stop` handle. */
export interface CliIo {
  /** Writes text to standard output. */
  readonly stdout: (text: string) => void;
  /** Writes text to standard error. */
  readonly stderr: (text: string) => void;
  /** Receives the `stop` handle of a server `serve` left running. */
  readonly onStop?: (stop: () => Promise<void>) => void;
}

/** The process's own streams, with a left-running server stopped on SIGINT or SIGTERM. */
const PROCESS_IO: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  onStop: stopOnSignal,
};

/**
 * Runs the CLI: resolves `args` with {@link run}, writes the result and
 * returns the exit code, turning an error that escapes a verb into exit 1
 * or 2.
 *
 * An error that is an instance of a known refusal class ({@link ImportError},
 * {@link ZipError}, {@link MergeRefusedError}, {@link ProjectConfigError},
 * {@link AgentSpawnError}, {@link AssessRefusedError},
 * {@link AgentOutputError}, {@link MissingDiscoveryError},
 * {@link ServePortError}, {@link MissingImportRecordError},
 * {@link ConfirmedFileError}, {@link ConfirmRefusedError},
 * {@link CaptureRefusedError}, {@link BaselinePathError},
 * {@link SeedRefusedError} or {@link SeedFileError}) prints `d2c: <message>` on stderr, without a
 * stack, and returns 1. Any other thrown value prints its stack, or `String(value)`
 * for a non-Error, on stderr and returns 2.
 *
 * @param args - The arguments after the script name.
 * @param options - Passed to {@link run} unchanged.
 * @param io - Where the output goes; the process's streams by default.
 * @returns The exit code: the result's own, or 1 or 2 for a thrown error.
 */
export async function main(
  args: readonly string[],
  options: CliOptions = {},
  io: CliIo = PROCESS_IO,
): Promise<number> {
  let result: CliResult;

  try {
    result = await run(args, options);
  } catch (error) {
    if (isRefusal(error)) {
      io.stderr(`d2c: ${error.message}\n`);

      return REFUSAL_EXIT_CODE;
    }

    io.stderr(`${describeUnexpected(error)}\n`);

    return UNEXPECTED_EXIT_CODE;
  }

  io.stdout(result.stdout);
  io.stderr(result.stderr);

  if (result.stop !== undefined) {
    io.onStop?.(result.stop);
  }

  return result.exitCode;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
