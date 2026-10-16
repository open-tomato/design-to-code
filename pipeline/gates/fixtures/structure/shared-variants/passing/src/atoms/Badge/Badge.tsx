import type { ReactNode } from 'react';

import { dotVariants } from '../../particles/Dot/Dot.variants';

/** A badge styled by the shared particle variants. */
export function Badge({ children }: { readonly children: ReactNode }) {
  return <span className={dotVariants()}>{children}</span>;
}
