import { describe, expect, test } from 'vitest';

import { cn } from './cn';

describe('cn', () => {
  test('joins class names in argument order', () => {
    expect(cn('px-2', 'text-sm')).toBe('px-2 text-sm');
  });

  test('drops falsy inputs and keeps truthy object keys', () => {
    const isActive = true;
    const isDisabled = false;

    expect(cn('base', null, undefined, false, { active: isActive, disabled: isDisabled })).toBe('base active');
  });

  test('flattens nested arrays', () => {
    expect(cn(['a', ['b', 'c']], 'd')).toBe('a b c d');
  });

  test('lets a later Tailwind utility override a conflicting earlier one', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
  });

  test('keeps non-conflicting utilities of the same family', () => {
    expect(cn('text-red-500', 'text-lg')).toBe('text-red-500 text-lg');
  });

  test('returns an empty string for no inputs', () => {
    expect(cn()).toBe('');
  });
});
