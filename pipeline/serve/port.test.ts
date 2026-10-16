import { describe, expect, test, vi } from 'vitest';

import {
  bindFirstFree,
  FIRST_PORT,
  LAST_PORT,
  OS_ASSIGNED_PORT,
  portCandidates,
  portFromEnv,
  ServePortError,
} from './port.ts';

/** An error shaped like the one a listen on a taken port rejects with. */
function inUse(port: number): Error {
  return Object.assign(new Error(`listen EADDRINUSE: 127.0.0.1:${port}`), { code: 'EADDRINUSE' });
}

describe('portFromEnv', () => {
  test('is undefined when D2C_PORT is not set', () => {
    expect(portFromEnv({})).toBeUndefined();
  });

  test.each(['1', '5123', '65535'])('reads %s as a port', (value) => {
    expect(portFromEnv({ D2C_PORT: value })).toBe(Number(value));
  });

  test.each(['', '0', '65536', '99999', '-1', '+80', ' 5123', '5123 ', '5123.5', '1e3', '0x10', '05123', 'abc'])(
    'refuses "%s"',
    (value) => {
      expect(() => portFromEnv({ D2C_PORT: value })).toThrow(ServePortError);
      expect(() => portFromEnv({ D2C_PORT: value })).toThrow(`D2C_PORT must be an integer from 1 to 65535, got "${value}"`);
    },
  );
});

describe('portCandidates', () => {
  test('tries FIRST_PORT up to LAST_PORT when nothing names a port', () => {
    const candidates = portCandidates(undefined, {});

    expect(candidates[0]).toBe(FIRST_PORT);
    expect(candidates.at(-1)).toBe(LAST_PORT);
    expect(candidates).toHaveLength(100);
  });

  test('tries D2C_PORT alone when it is set', () => {
    expect(portCandidates(undefined, { D2C_PORT: '5123' })).toEqual([5123]);
  });

  test('tries a named port alone, over D2C_PORT', () => {
    expect(portCandidates(5200, { D2C_PORT: '5123' })).toEqual([5200]);
  });

  test('tries a named port 0 alone, over D2C_PORT, so the OS assigns one', () => {
    expect(OS_ASSIGNED_PORT).toBe(0);
    expect(portCandidates(0, { D2C_PORT: '5123' })).toEqual([0]);
  });

  test.each([-1, 65536, 5123.5, Number.NaN])('refuses the named port %s', (port) => {
    expect(() => portCandidates(port, {})).toThrow(ServePortError);
    expect(() => portCandidates(port, {})).toThrow(`port must be an integer from 0 to 65535, got ${port}`);
  });

  test('refuses D2C_PORT=0 even though a named port 0 is accepted', () => {
    expect(() => portCandidates(undefined, { D2C_PORT: '0' })).toThrow(ServePortError);
    expect(() => portCandidates(undefined, { D2C_PORT: '0' })).toThrow('D2C_PORT must be an integer from 1 to 65535, got "0"');
  });

  test('refuses an invalid D2C_PORT', () => {
    expect(() => portCandidates(undefined, { D2C_PORT: 'eighty' })).toThrow(ServePortError);
  });
});

describe('bindFirstFree', () => {
  test('takes the first candidate that binds, moving past ports in use', async () => {
    const tryPort = vi.fn(async (port: number) => {
      if (port < 5125) {
        throw inUse(port);
      }
    });

    await expect(bindFirstFree([5123, 5124, 5125, 5126], tryPort)).resolves.toBe(5125);
    expect(tryPort.mock.calls).toEqual([[5123], [5124], [5125]]);
  });

  test('takes the first candidate when it binds', async () => {
    const tryPort = vi.fn(async () => {});

    await expect(bindFirstFree([5123, 5124], tryPort)).resolves.toBe(5123);
    expect(tryPort).toHaveBeenCalledTimes(1);
  });

  test('names the port when the only candidate is in use', async () => {
    const tryPort = vi.fn(async (port: number) => {
      throw inUse(port);
    });

    await expect(bindFirstFree([5123], tryPort)).rejects.toThrow(new ServePortError('port 5123 is already in use'));
    expect(tryPort).toHaveBeenCalledTimes(1);
  });

  test('names the range when every candidate is in use', async () => {
    const tryPort = vi.fn(async (port: number) => {
      throw inUse(port);
    });

    await expect(bindFirstFree([5123, 5124, 5125], tryPort)).rejects.toThrow('no free port from 5123 to 5125');
  });

  test('rejects at once on a failure other than a port in use', async () => {
    const tryPort = vi.fn(async () => {
      throw Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    });

    await expect(bindFirstFree([5123, 5124], tryPort)).rejects.toThrow('listen EACCES');
    expect(tryPort).toHaveBeenCalledTimes(1);
  });
});
