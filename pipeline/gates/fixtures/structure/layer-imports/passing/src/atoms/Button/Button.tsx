import type { ReactNode } from 'react';

import { Dot } from '../../particles/Dot/Dot';

import { ButtonLabel } from './ButtonLabel';

/** The props of a `Button`. */
export interface ButtonProps {
  readonly children: ReactNode;
}

/** A button that imports a lower level and a file of its own folder. */
export function Button({ children }: ButtonProps) {
  return (
    <button type="button">
      <Dot />
      <ButtonLabel>{children}</ButtonLabel>
    </button>
  );
}
