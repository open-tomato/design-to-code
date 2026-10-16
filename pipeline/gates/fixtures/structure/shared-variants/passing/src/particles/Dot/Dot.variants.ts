/** The class names of a `Dot`, by tone. */
export function dotVariants(tone: 'plain' | 'loud' = 'plain'): string {
  return tone === 'plain'
    ? 'dot'
    : 'dot dot-loud';
}
