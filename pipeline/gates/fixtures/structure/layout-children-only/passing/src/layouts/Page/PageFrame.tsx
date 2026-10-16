import type { ReactNode } from 'react';

/** The frame of a `Page`, a part of its own folder. */
export function PageFrame({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <main aria-label={label}>{children}</main>;
}
