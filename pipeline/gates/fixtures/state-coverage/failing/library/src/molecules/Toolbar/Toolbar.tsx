import type { ReactNode } from 'react';

/** The props of a `Toolbar`. */
export interface ToolbarProps {
  /** The toolbar's actions. */
  readonly children?: ReactNode;
}

/** A row of actions. */
export function Toolbar({ children }: ToolbarProps) {
  return <div role="toolbar">{children}</div>;
}
