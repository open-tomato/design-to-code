/**
 * The agent spawners the `assess` verb runs: {@link processSpawner} turns a
 * command into an {@link AgentSpawner} that writes the prompt to the
 * child's stdin and resolves to everything it printed on stdout, and
 * {@link claudeSpawner} is that spawner for `claude -p`.
 *
 * A child that cannot be started, that exits non-zero or is killed by a
 * signal rejects with an {@link AgentSpawnError}, whose message names the
 * command and, when the child printed any, the end of its stderr.
 *
 * The prompts embed content from the design export, which is untrusted, so
 * {@link claudeSpawner} gives the agent nothing to act with: no tools, plan
 * mode, no MCP servers and no settings files ({@link CLAUDE_COMMAND}), a
 * fresh empty temp dir as its working directory, and only the environment
 * variables {@link agentEnv} keeps.
 *
 * @packageDocumentation
 */

import type { AgentSpawner } from '../../pipeline/assess/agent.ts';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The most characters of the child's stderr an error message quotes. */
export const STDERR_TAIL_LENGTH = 2000;

/**
 * The command the `assess` and `seed` verbs run the agent with: print mode,
 * every built-in tool off (`--tools ""`), plan mode, MCP servers only from
 * an `--mcp-config` (none is passed), and no user, project or local
 * settings files (`--setting-sources ""`).
 */
export const CLAUDE_COMMAND: readonly [string, ...string[]] = [
  'claude',
  '-p',
  '--tools',
  '',
  '--permission-mode',
  'plan',
  '--strict-mcp-config',
  '--setting-sources',
  '',
];

/** The environment variables the agent keeps by exact name. */
export const AGENT_ENV_NAMES: readonly string[] = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'];

/** The environment variable prefixes the agent keeps: its own auth and config. */
export const AGENT_ENV_PREFIXES: readonly string[] = ['ANTHROPIC_', 'CLAUDE_'];

/** An environment as `process.env` holds it: unset names map to `undefined`. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The prefix of the temp dir each agent child runs in. */
const AGENT_CWD_PREFIX = 'd2c-agent-';

/** Starts the child process; `node:child_process`'s `spawn` unless a test stubs it. */
export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

/** How {@link processSpawner} starts each child. */
export interface ProcessSpawnerOptions {
  /** The child's environment; the parent's whole environment when absent. */
  readonly env?: Environment;
  /** Run each child in a fresh empty temp dir, removed once it exits. */
  readonly isolateCwd?: boolean;
  /** Starts the child; `spawn` from `node:child_process` by default. */
  readonly spawnProcess?: SpawnProcess;
}

/**
 * The entries of `env` the agent keeps: {@link AGENT_ENV_NAMES} and any
 * name starting with one of {@link AGENT_ENV_PREFIXES}. Unset entries are
 * dropped.
 */
export function agentEnv(env: Environment): Record<string, string> {
  const kept = (name: string) => AGENT_ENV_NAMES.includes(name)
    || AGENT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));

  return Object.fromEntries(Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && kept(entry[0])));
}

/** An agent process that could not be started or did not exit cleanly. */
export class AgentSpawnError extends Error {
  override readonly name = 'AgentSpawnError';
}

/** `stderr` trimmed to its last {@link STDERR_TAIL_LENGTH} characters. */
function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();

  return trimmed.length > STDERR_TAIL_LENGTH
    ? `...${trimmed.slice(-STDERR_TAIL_LENGTH)}`
    : trimmed;
}

/** How the child ended, as a clause for an error message. */
function describeExit(code: number | null, signal: string | null): string {
  return signal === null
    ? `exited with code ${code}`
    : `was killed by ${signal}`;
}

/**
 * An {@link AgentSpawner} that runs `command` once per prompt, writing the
 * prompt to its stdin and resolving to its stdout, decoded as UTF-8.
 *
 * @param command - The executable and its arguments, run without a shell.
 * @param options - The child's environment and working directory, and the
 * function that starts it.
 * @returns The spawner.
 */
export function processSpawner(
  command: readonly [string, ...string[]],
  options: ProcessSpawnerOptions = {},
): AgentSpawner {
  const [executable, ...args] = command;
  const display = command.join(' ');
  const { env, isolateCwd = false, spawnProcess = spawn } = options;

  return (prompt) => new Promise<string>((resolvePromise, reject) => {
    const cwd = isolateCwd
      ? mkdtempSync(join(tmpdir(), AGENT_CWD_PREFIX))
      : undefined;
    const removeCwd = () => {
      if (cwd !== undefined) rmSync(cwd, { recursive: true, force: true });
    };
    let child: ReturnType<SpawnProcess>;

    try {
      child = spawnProcess(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      removeCwd();
      reject(new AgentSpawnError(`${display}: could not be started (${(error as Error).message})`, { cause: error }));

      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdinError: Error | undefined;

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    // A child that exits before reading its stdin breaks the pipe; the
    // exit status decides whether that is a failure.
    child.stdin.on('error', (error) => {
      stdinError = error;
    });
    child.on('error', (error) => {
      removeCwd();
      reject(new AgentSpawnError(`${display}: could not be started (${error.message})`, { cause: error }));
    });
    child.on('close', (code, signal) => {
      removeCwd();

      const errorOutput = stderrTail(Buffer.concat(stderr).toString('utf8'));

      if (code === 0 && stdinError === undefined) {
        resolvePromise(Buffer.concat(stdout).toString('utf8'));

        return;
      }

      const reason = code === 0
        ? `did not read the prompt (${stdinError?.message})`
        : describeExit(code, signal);

      reject(new AgentSpawnError(errorOutput === ''
        ? `${display}: ${reason}`
        : `${display}: ${reason}: ${errorOutput}`));
    });
    child.stdin.end(prompt, 'utf8');
  });
}

/**
 * {@link CLAUDE_COMMAND} as a spawner, each child in a fresh empty temp dir
 * with only the variables {@link agentEnv} keeps from `env`.
 *
 * @param spawnProcess - Starts the child; `spawn` by default.
 * @param env - The environment to filter; the parent's by default.
 */
export function claudeSpawnerWith(
  spawnProcess: SpawnProcess = spawn,
  env: Environment = process.env,
): AgentSpawner {
  return processSpawner(CLAUDE_COMMAND, { env: agentEnv(env), isolateCwd: true, spawnProcess });
}

/**
 * The spawner the `assess` and `seed` verbs use unless a caller injects
 * another; it reads `process.env` at each call.
 */
export const claudeSpawner: AgentSpawner = (prompt) => claudeSpawnerWith()(prompt);
