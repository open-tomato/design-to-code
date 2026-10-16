import type { ReactNode } from 'react';

import * as Atoms from '../../atoms/Button/Button';
import { Header } from '../../organisms/Header/Header';

/** The props of a `Page`. */
export interface PageProps {
  readonly title: string;
  readonly children: ReactNode;
}

/** A page that hands data down as props instead of through context. */
export function Page({ title, children }: PageProps) {
  const rest = { id: 'page-menu' };

  return (
    <main>
      <Header title={title} key="header">
        <Atoms.Button {...rest}>Menu</Atoms.Button>
      </Header>
      {children}
    </main>
  );
}
