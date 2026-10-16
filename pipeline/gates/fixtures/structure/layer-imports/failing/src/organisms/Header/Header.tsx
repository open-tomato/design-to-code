import { Button } from '../../atoms/Button/Button';

/** The props of a `Header`. */
export interface HeaderProps {
  readonly title: string;
}

/** A header that imports only from a lower level. */
export function Header({ title }: HeaderProps) {
  return (
    <header>
      <h1>{title}</h1>
      <Button>Menu</Button>
    </header>
  );
}
