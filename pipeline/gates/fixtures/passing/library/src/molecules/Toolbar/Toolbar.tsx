import type { VariantProps } from '../../lib/variants';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { Dot } from '../../particles/Dot/Dot';

import { toolbarVariants } from './Toolbar.variants';

/** The props of a `Toolbar`. */
export interface ToolbarProps extends VariantProps<typeof toolbarVariants> {
  /** The toolbar's actions. */
  readonly children?: ReactNode;
  /** Classes merged after the variant classes. */
  readonly className?: string;
}

/** A row of actions led by a status dot. */
export function Toolbar({ density, className, children }: ToolbarProps) {
  return (
    <div role="toolbar" className={cn(toolbarVariants({ density }), className)}>
      <Dot tone="accent" />
      {children}
    </div>
  );
}
