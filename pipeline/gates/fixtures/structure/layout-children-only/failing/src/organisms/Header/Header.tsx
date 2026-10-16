import type { ReactNode } from 'react';

/** The props of a `Header`: a title handed down as a prop. */
export interface HeaderProps {
  readonly title: string;
  readonly children: ReactNode;
}

/** A header that takes its title as a prop. */
export function Header({ title, children }: HeaderProps) {
  return (
    <header>
      <h1>{title}</h1>
      {children}
    </header>
  );
}
