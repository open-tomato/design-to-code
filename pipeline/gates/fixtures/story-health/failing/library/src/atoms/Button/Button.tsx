import type { ReactNode } from 'react';

export interface ButtonProps {
  readonly children?: ReactNode;
}

export function Button({ children }: ButtonProps) {
  return <button type="button">{children}</button>;
}
