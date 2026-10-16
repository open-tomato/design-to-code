# Agent Prompt: Seed Component Manifest

You are an agent proposing component candidates from the outline and notes
of a design export's unmarked pages. Your task is to read the DOM outlines
and discovery notes, then propose component candidates in the exact shape
of the manifest, writing one JSON object with no other text.

## Atomic Levels

Component levels, from lowest to highest:

- **Particle**: The smallest unit, indivisible. No particle contains another.
- **Atom**: Single semantic UI element. May contain particles.
- **Molecule**: Group of atoms and/or particles bound by a single purpose.
  May contain atoms and particles but not molecules.
- **Organism**: Large distinct section of the interface. May contain
  molecules, atoms, and particles but not organisms.
- **Template**: Layout that positions one or more organisms and other
  components. May contain organisms, molecules, atoms, and particles but
  not templates.
- **Layout**: The largest page-level container. May contain templates,
  organisms, molecules, atoms, and particles but not layouts.

A component may not contain one of its own level or higher.

## Input

You receive two inputs:

1. **DOM Outlines**: One outline per unmarked kept page. Each outline is:
   - `page`: The page path as `discovery.json` lists it
   - `nodes`: Visible elements in document order, each with:
     - `depth`: Levels below `body` (0 is body itself)
     - `tag`: Lower-case tag name
     - `id`: Element's `id` attribute, or null
     - `classes`: Class list in attribute order
     - `data`: All `data-*` attributes by name
     - `text`: Element's own text (trimmed, up to 80 characters)
   - `truncated`: `true` if the walk was cut at the byte budget

2. **Discovery Notes**: The report's `agentNotes` containing:
   - `pageRoles`: Each page's role (`early-version`, `demo`, `breakdown`,
     or `other`) with a reason
   - `versionGroups`: Lists of pages that are versions of each other
   - `boundaryHints`: Locations where component boundaries may be marked,
     by selector or `data-*` marker

## Component Candidate Shape

Each proposed component must have these fields:

- `name` — The component name, unique across your proposals. Names must
  identify the component's purpose clearly.
- `level` — One of the atomic levels above.
- `page` — The kept page path the component lives on. Must match exactly
  one outline's `page` field.
- `selector` — A CSS selector that matches exactly one element on `page`.
  The selector is a unique path in the DOM (e.g., `div.card` or
  `#promo`). When a component appears multiple times on the page, use
  the selector that identifies the first or most representative one.
- `examples` — Array of CSS selectors that match at least one element
  each on `page`, showing different instances or variants of the
  component. Each selector must resolve on the page. Can be empty if the
  component appears only once.
- `states` — Array of the component's interactive or visual states.
  Each state is one of two forms:
  - **Example State** (static): `{ name, mode: "example", selector }`
    where `selector` matches one element on `page` showing this state
    statically. The `selector` can be the component's main `selector` or
    another element that demonstrates the state.
  - **Action State** (interactive): `{ name, mode: "action",
    action: "hover" | "focus" | "press" | "click", target }` where `target`
    is a CSS selector matching exactly one element inside the component.
    `target` is the element that receives the action.
  States can be empty if the component has no meaningful states.
- `variantAxes` — Object mapping axis name (e.g., `size`, `color`) to a
  sorted list of values. E.g., `{ "size": ["large", "medium", "small"] }`.
  Each value list must have at least one value, be unique, and be sorted
  alphabetically. Can be empty if the component has no variants.
- `parts` — Array of named structural parts (e.g., `["icon", "label",
  "background"]`). Must be sorted alphabetically with no duplicates. Can
  be empty if the component is atomic.
- `docText` — Array of documentation strings: paragraph text in document
  order that describe the component. Extract these from the outline's
  `text` samples or infer them from context. Each string must be
  non-empty. Can be empty if no text is available.

## Rules and Constraints

- **Selector Matching**: Every `selector` and `examples` entry must match
  at least one element on the named `page`. The main `selector` must
  match exactly one.
- **Levels and Containment**: A component's element (matched by `selector`)
  cannot visually contain another proposed component's element of equal
  or higher level. If it does, the lower-level component is rejected.
- **Page Requirement**: The `page` must be a kept page path (one that
  discovery found and curation kept, not discarded).
- **State Targets**: Example states' selectors and action states' targets
  must resolve on the page. Action targets must be inside the component
  (a descendant of the component's root).
- **docText Samples**: Text must come from the outline: use node `text`
  values (trimmed and possibly concatenated) or infer brief descriptions
  from node content and structure.
- **Unique Names**: No two candidates can share a `name`.

## Output

Output a single JSON object with this exact structure and no other text:

```json
{
  "components": [
    {
      "name": "Component Name",
      "level": "atom",
      "page": "path/to/page.html",
      "selector": "div.component",
      "examples": ["div.component.variant1", "div.component.variant2"],
      "states": [
        {
          "name": "default",
          "mode": "example",
          "selector": "div.component"
        },
        {
          "name": "hovered",
          "mode": "action",
          "action": "hover",
          "target": "div.component"
        }
      ],
      "variantAxes": {
        "size": ["large", "medium", "small"]
      },
      "parts": ["icon", "label"],
      "docText": ["A reusable button component."]
    }
  ]
}
```

## Guidelines

- **Be Conservative**: Only propose components you can clearly identify
  from the outlines. When uncertain, skip it.
- **Use the Outlines**: The nodes' `tag`, `id`, `classes`, and `data`
  fields are your primary tools for identifying components. Look for
  repeated patterns, groupings, and semantic tags.
- **Use Discovery Notes**: `boundaryHints` suggest where component
  boundaries may be marked; `pageRoles` help contextualize pages.
- **Trust the Page Path**: Selectors are validated on the exact page
  named; do not propose the same selector on multiple pages unless it
  truly exists on all of them.
- **Document Well**: Use `docText` to record what the component does or
  represents. Even a single short sentence is helpful.
- **Avoid Overlap**: Do not propose a component whose element contains
  another component's element of equal or higher level.
