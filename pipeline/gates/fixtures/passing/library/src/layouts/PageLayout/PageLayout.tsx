import type { VariantProps } from '../../lib/variants';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { Stack } from '../../templates/Stack/Stack';

import { pageLayoutVariants } from './PageLayout.variants';

/** The props of a `PageLayout`. */
export interface PageLayoutProps extends VariantProps<typeof pageLayoutVariants> {
  /** The page's content. */
  readonly children?: ReactNode;
  /** Classes merged after the variant classes. */
  readonly className?: string;
}

/**
 * The page frame. It passes its content to `Stack` as `children` and
 * nothing else; anything more reaches the content through context.
 */
export function PageLayout({ width, className, children }: PageLayoutProps) {
  return (
    <main className={cn(pageLayoutVariants({ width }), className)}>
      <Stack>{children}</Stack>
    </main>
  );
}
