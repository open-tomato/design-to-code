import type { Environment, SpawnProcess } from './spawner.ts';

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'vitest';

import {
  agentEnv,
  AgentSpawnError,
  CLAUDE_COMMAND,
  claudeSpawnerWith,
  processSpawner,
  STDERR_TAIL_LENGTH,
} from './spawner.ts';

/** A spawner running a script under the current runtime (node or bun). */
function scriptSpawner(script: string) {
  return processSpawner([process.execPath, '-e', script]);
}

describe('processSpawner', () => {
  test('writes the prompt to stdin and resolves to stdout', async () => {
    const spawn = scriptSpawner('process.stdin.pipe(process.stdout)');

    await expect(spawn('prompt with ünïcode\n{"a":1}')).resolves.toBe('prompt with ünïcode\n{"a":1}');
  });

  test('resolves to stdout only, leaving stderr out', async () => {
    const spawn = scriptSpawner('process.stderr.write("noise"); process.stdout.write("out")');

    await expect(spawn('')).resolves.toBe('out');
  });

  test('rejects a non-zero exit naming the command, the code and stderr', async () => {
    const spawn = processSpawner([process.execPath, '-e', 'process.stderr.write("not logged in\\n"); process.exit(3)']);
    const failure = spawn('prompt');

    await expect(failure).rejects.toBeInstanceOf(AgentSpawnError);
    await expect(failure).rejects.toThrow(/: exited with code 3: not logged in$/);
  });

  test('rejects a non-zero exit with no stderr without a trailing colon', async () => {
    await expect(scriptSpawner('process.exit(4)')('')).rejects.toThrow(/: exited with code 4$/);
  });

  test('quotes only the end of a long stderr', async () => {
    const spawn = scriptSpawner(`process.stderr.write("a".repeat(${STDERR_TAIL_LENGTH * 2}) + "END"); process.exit(1)`);
    const error = await spawn('').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AgentSpawnError);
    expect((error as Error).message.endsWith('aaaEND')).toBe(true);
    expect((error as Error).message.length).toBeLessThan(STDERR_TAIL_LENGTH + 200);
  });

  test('rejects a command that cannot be started', async () => {
    const spawn = processSpawner(['d2c-no-such-command-for-tests', '-p']);

    await expect(spawn('prompt')).rejects.toThrow(/^d2c-no-such-command-for-tests -p: could not be started \(/);
  });
});

describe('CLAUDE_COMMAND', () => {
  test('runs claude in print mode with no tools, plan mode, no MCP servers and no settings files', () => {
    expect(CLAUDE_COMMAND).toEqual([
      'claude',
      '-p',
      '--tools',
      '',
      '--permission-mode',
      'plan',
      '--strict-mcp-config',
      '--setting-sources',
      '',
    ]);
  });
});

describe('agentEnv', () => {
  test('keeps PATH, HOME, USER, LOGNAME, TMPDIR, LANG and the ANTHROPIC_ and CLAUDE_ variables, and drops the rest', () => {
    const env = agentEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      USER: 'user',
      LOGNAME: 'user',
      TMPDIR: '/tmp/user',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: 'key',
      CLAUDE_CONFIG_DIR: '/home/user/.claude',
      GITHUB_TOKEN: 'gh-token',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      NPM_TOKEN: 'npm-token',
      MY_ANTHROPIC_KEY: 'not a prefix match',
      SHELL: '/bin/zsh',
      UNSET: undefined,
    });

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
      USER: 'user',
      LOGNAME: 'user',
      TMPDIR: '/tmp/user',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: 'key',
      CLAUDE_CONFIG_DIR: '/home/user/.claude',
    });
  });
});

describe('claudeSpawnerWith', () => {
  /** What the stubbed spawn was called with, and what its cwd held at that moment. */
  interface SpawnCall {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string | undefined;
    readonly cwdEntries: readonly string[];
    readonly env: Environment | undefined;
  }

  /**
   * A spawn stub that records each call, then runs `script` under the
   * current runtime with the options it was given, so cwd, env and stdin
   * reach a real child.
   */
  function recordingSpawn(script: string): { spawnProcess: SpawnProcess, calls: SpawnCall[] } {
    const calls: SpawnCall[] = [];
    const spawnProcess: SpawnProcess = (command, args, options) => {
      const cwd = options.cwd?.toString();

      calls.push({
        command,
        args,
        cwd,
        cwdEntries: cwd === undefined
          ? []
          : readdirSync(cwd),
        env: options.env,
      });

      return spawn(process.execPath, ['-e', script], options);
    };

    return { spawnProcess, calls };
  }

  const PARENT_ENV = {
    PATH: process.env.PATH,
    HOME: '/home/user',
    ANTHROPIC_API_KEY: 'key',
    GITHUB_TOKEN: 'gh-token',
  };

  test('spawns claude with the restricting flags and the allow-listed env, prompt on stdin', async () => {
    const { spawnProcess, calls } = recordingSpawn('process.stdin.pipe(process.stdout)');

    const output = await claudeSpawnerWith(spawnProcess, PARENT_ENV)('untrusted prompt');

    expect(output).toBe('untrusted prompt');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('claude');
    expect(calls[0]?.args).toEqual(CLAUDE_COMMAND.slice(1));
    expect(calls[0]?.env).toEqual({ PATH: process.env.PATH, HOME: '/home/user', ANTHROPIC_API_KEY: 'key' });
  });

  test('runs each prompt in a fresh, empty temp dir, removed once the child exits', async () => {
    const { spawnProcess, calls } = recordingSpawn('process.stdout.write(process.cwd())');
    const spawner = claudeSpawnerWith(spawnProcess, PARENT_ENV);

    const reported = [await spawner(''), await spawner('')];
    const [first, second] = calls.map(({ cwd }) => cwd ?? '');

    expect(first).not.toBe('');
    expect(first).not.toBe(second);
    expect(realpathSync(process.cwd())).not.toBe(reported[0]);
    expect(reported.every((dir) => dir.startsWith(realpathSync(tmpdir())))).toBe(true);
    expect(calls.map(({ cwdEntries }) => cwdEntries)).toEqual([[], []]);
    expect([first, second].map((dir) => existsSync(dir ?? ''))).toEqual([false, false]);
  });

  test('removes the temp dir when the child cannot be started', async () => {
    const calls: string[] = [];
    const spawnProcess: SpawnProcess = (_command, args, options) => {
      calls.push(options.cwd?.toString() ?? '');

      return spawn('d2c-no-such-command-for-tests', args, options);
    };

    await expect(claudeSpawnerWith(spawnProcess, PARENT_ENV)('prompt')).rejects.toBeInstanceOf(AgentSpawnError);
    expect(calls).toHaveLength(1);
    expect(existsSync(calls[0] ?? '')).toBe(false);
  });

  test('removes the temp dir and rejects with AgentSpawnError when starting the child throws', async () => {
    const calls: string[] = [];
    const spawnProcess: SpawnProcess = (_command, _args, options) => {
      calls.push(options.cwd?.toString() ?? '');
      throw new TypeError('an env value holds a NUL byte');
    };

    await expect(claudeSpawnerWith(spawnProcess, PARENT_ENV)('prompt')).rejects.toBeInstanceOf(AgentSpawnError);
    expect(calls).toHaveLength(1);
    expect(existsSync(calls[0] ?? '')).toBe(false);
  });
});
