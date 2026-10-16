import type { ReactNode } from 'react';

/** The props of a `Button`. */
export interface ButtonProps {
  /** The button's label. */
  readonly children: ReactNode;
  /** Whether the button refuses presses. */
  readonly disabled?: boolean;
}

/** A button whose `className` is a string literal, not a variants call. */
export function Button({ disabled, children }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="inline-flex rounded px-4"
    >
      {children}
    </button>
  );
}
