import type { ReactNode } from 'react';

/** The label inside a `Button`, a file of the `Button` folder. */
export function ButtonLabel({ children }: { readonly children: ReactNode }) {
  return <span>{children}</span>;
}
