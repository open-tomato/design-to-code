import type { ReactNode } from 'react';

import { Button } from '../../atoms/Button/Button';
import { Dot } from '../../particles/Dot/Dot';

/** The props of a `Toolbar`. */
export interface ToolbarProps {
  /** The toolbar's actions. */
  readonly children?: ReactNode;
}

/** A row of actions whose `Button` gets a string where it takes a boolean. */
export function Toolbar({ children }: ToolbarProps) {
  return (
    <div role="toolbar">
      <Dot />
      <Button disabled="yes">Close</Button>
      {children}
    </div>
  );
}
