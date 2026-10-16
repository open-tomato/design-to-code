import type { VariantProps } from '../../lib/variants';

import { Button } from '../../atoms/Button/Button';
import { cn } from '../../lib/cn';

import { headerVariants } from './Header.variants';

/** The props of a `Header`. */
export interface HeaderProps extends VariantProps<typeof headerVariants> {
  /** The title shown at the start of the header. */
  readonly title: string;
  /** Classes merged after the variant classes. */
  readonly className?: string;
}

/** A page header: a title and a menu button. */
export function Header({ title, elevation, className }: HeaderProps) {
  return (
    <header className={cn(headerVariants({ elevation }), className)}>
      <h1>{title}</h1>
      <Button intent="secondary" size="sm">Menu</Button>
    </header>
  );
}
