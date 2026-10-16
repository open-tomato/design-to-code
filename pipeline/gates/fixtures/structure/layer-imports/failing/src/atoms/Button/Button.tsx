import type { ReactNode } from 'react';

import { Icon } from '../Icon/Icon';

/** The props of a `Button`. */
export interface ButtonProps {
  readonly children: ReactNode;
}

/** A button that imports `Icon`, a component of its own level. */
export function Button({ children }: ButtonProps) {
  return (
    <button type="button">
      <Icon />
      {children}
    </button>
  );
}
