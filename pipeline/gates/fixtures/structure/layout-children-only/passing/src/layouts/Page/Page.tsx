import type { ReactNode } from 'react';
import type { ButtonProps } from '../../atoms/Button/Button';

import { Button } from '../../atoms/Button/Button';
import { PageTitle } from '../../lib/page-title';
import { cva } from '../../lib/variants';
import { Header } from '../../organisms/Header/Header';

import { PageFrame } from './PageFrame';

/** The classes of a `Page`'s body. */
const pageBodyVariants = cva('page-body');

/** The props of a `Page`. */
export interface PageProps {
  readonly title: string;
  readonly actions: readonly ButtonProps['children'][];
  readonly children: ReactNode;
}

/** A page that hands its title down through context, never as a prop. */
export function Page({ title, actions, children }: PageProps) {
  return (
    <PageTitle.Provider value={title}>
      <PageFrame label={title}>
        <Header>
          {actions.map((action, index) => <Button key={index}>{action}</Button>)}
          <Button children="Help" />
        </Header>
        <section className={pageBodyVariants()}>{children}</section>
      </PageFrame>
    </PageTitle.Provider>
  );
}
