import type { ReactNode } from 'react';

import { Button } from '../../atoms/Button/Button';
import { buttonVariants } from '../../atoms/Button/Button.variants.js';

/** The props of a `Header`. */
export interface HeaderProps {
  readonly children: ReactNode;
}

/** A header that borrows the variants of `Button` too. */
export function Header({ children }: HeaderProps) {
  return (
    <header className={buttonVariants()}>
      {children}
      <Button>Menu</Button>
    </header>
  );
}
