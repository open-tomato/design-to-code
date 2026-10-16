/**
 * Adds the `Badge` atom to `widgets.html` from script, so a reader that
 * only scanned the static HTML would miss it.
 *
 * @packageDocumentation
 */

const badge = document.createElement('span');
badge.setAttribute('data-component', 'Badge');
badge.setAttribute('data-level', 'atom');
badge.textContent = 'New';
document.getElementById('widgets')?.append(badge);
