/** Joins the truthy class names with a space. */
export function cn(...classNames: readonly (string | false | undefined)[]): string {
  return classNames.filter(Boolean).join(' ');
}
