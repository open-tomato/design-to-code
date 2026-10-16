/**
 * Variant helpers for components.
 *
 * Components declare their variants with `cva` in a colocated
 * `<Name>.variants.ts` and derive their prop types with `VariantProps`.
 * Importing both from here, rather than from `class-variance-authority`
 * directly, keeps the library on one pinned source for the variant API.
 *
 * @packageDocumentation
 */
export { cva, type VariantProps } from 'class-variance-authority';
