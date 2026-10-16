/**
 * Runtime shim of the `with-ds` fixture export, standing in for the
 * `support.js` a Claude Design export ships beside its pages.
 *
 * @packageDocumentation
 */

/** Records which screen asked to mount, so a page can call it inline. */
window.dcSupport = {
  mounted: [],
  mount(screen) {
    this.mounted.push(screen);
  },
};
