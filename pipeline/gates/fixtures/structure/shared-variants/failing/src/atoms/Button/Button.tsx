import type { ReactNode } from 'react';

import { buttonVariants } from './Button.variants';

/** The props of a `Button`. */
export interface ButtonProps {
  readonly children: ReactNode;
}

/** A button styled by its own variants. */
export function Button({ children }: ButtonProps) {
  return <button type="button" className={buttonVariants()}>{children}</button>;
}
