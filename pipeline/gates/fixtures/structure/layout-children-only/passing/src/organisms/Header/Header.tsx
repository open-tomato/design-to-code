import type { ReactNode } from 'react';

import { useContext } from 'react';

import { Button } from '../../atoms/Button/Button';
import { PageTitle } from '../../lib/page-title';

/** A header that reads its title from context; below the highest level, it may pass props. */
export function Header({ children }: { readonly children: ReactNode }) {
  const title = useContext(PageTitle);

  return (
    <header>
      <h1>{title}</h1>
      <Button tone="quiet">Menu</Button>
      {children}
    </header>
  );
}
