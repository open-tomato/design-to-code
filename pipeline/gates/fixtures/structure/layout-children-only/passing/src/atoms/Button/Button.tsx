import type { ReactNode } from 'react';

/** The props of a `Button`. */
export interface ButtonProps {
  readonly tone?: 'plain' | 'quiet';
  readonly children: ReactNode;
}

/** A plain button. */
export function Button({ tone = 'plain', children }: ButtonProps) {
  return <button data-tone={tone} type="button">{children}</button>;
}
