import type { ReactNode } from 'react';

/** The props of a `Button`. */
export interface ButtonProps {
  /** The button's label. */
  readonly children?: ReactNode;
}

/** A button with no variants. */
export function Button({ children }: ButtonProps) {
  return <button type="button">{children}</button>;
}
