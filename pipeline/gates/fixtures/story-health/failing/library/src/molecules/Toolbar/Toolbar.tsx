import type { ReactNode } from 'react';

export function Toolbar({ children }: { readonly children?: ReactNode }) {
  return <div role="toolbar">{children}</div>;
}
