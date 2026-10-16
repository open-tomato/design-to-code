/** The class names of a `Button`, by intent. */
export function buttonVariants(intent: 'primary' | 'quiet' = 'primary'): string {
  return intent === 'primary'
    ? 'button button-primary'
    : 'button button-quiet';
}
