import type { ReactNode } from 'react';

/** The props of a `Button`. */
export interface ButtonProps {
  readonly id?: string;
  readonly children: ReactNode;
}

/** A plain button. */
export function Button({ id, children }: ButtonProps) {
  return <button id={id} type="button">{children}</button>;
}
