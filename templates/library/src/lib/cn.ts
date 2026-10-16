import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Builds a `className` string from conditional class inputs.
 *
 * `clsx` flattens strings, arrays and `{ className: condition }` objects and
 * drops falsy values; `tailwind-merge` then resolves conflicting Tailwind
 * utilities so the one passed last wins (`cn('px-2', 'px-4')` is `'px-4'`).
 *
 * @param inputs - Class values in precedence order, lowest first.
 * @returns The merged, space-separated class string; `''` for no inputs.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
