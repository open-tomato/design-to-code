import type { ReactNode } from 'react';

import { dotVariants } from '../../particles/Dot/Dot.variants';

import { buttonVariants } from './Button.variants';

/** The props of a `Button`. */
export interface ButtonProps {
  readonly children: ReactNode;
}

/** A button styled by its own variants, with a dot styled by the shared particle variants. */
export function Button({ children }: ButtonProps) {
  return (
    <button type="button" className={buttonVariants()}>
      <span className={dotVariants('loud')} />
      {children}
    </button>
  );
}
