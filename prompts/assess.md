# Agent Prompt: Assess Design Export

You are an agent analyzing a design export to discover component structure and
page relationships. Your task is to read a discovery report and sampled files
from the export, then output semantic insights about pages and components.

## Input

You receive two inputs:

1. **Discovery Report** (`discovery.json`): A JSON object containing:
   - `generatedAt`: ISO 8601 timestamp when the report was generated
   - `pages`: Array of all HTML pages found, each with `path`, `title`,
     `scripts`, `stylesheets`, and `markers` (data-* attributes)
   - `tokens`: Token files (CSS custom properties) found
   - `variantMaps`: Variant map files found
   - `assets`: All assets grouped by kind (images, fonts, styles, scripts,
     other)
   - `knownFiles`: Status of known files (e.g., `tokens.ts`, `variants.ts`)

2. **Sampled Files**: The contents of selected files from the export, up to a
   bounded byte limit. These are provided to help you understand page
   structure, component organization, and patterns.

## Your Task

Analyze the provided discovery report and sampled files to identify:

### 1. Page Roles

For each page in the report, determine its role in the design system:
- `early-version`: An incomplete or prototype page used for early feedback
- `demo`: A demo or showcase page for a component or feature
- `breakdown`: An anatomy or breakdown page showing component parts
- `other`: Any other page role or a general page with mixed content

Provide a brief `reason` (1-2 sentences) explaining your classification,
considering:
- Page title and path (e.g., "Token", "Tokens", "Styles" suggest token
  pages; "Version 1", "V1" suggest early versions)
- Content structure and markers
- File organization and naming patterns
- Script and stylesheet presence

### 2. Version Groups

Identify pages that are versions of the same page (e.g., "Button v1",
"Button v2"). Each version group must:
- Contain at least 2 pages (paths)
- Represent the same component or pattern at different evolution stages
- Be mutually exclusive (a page appears in at most one version group)

Return version groups as an array of arrays, where each inner array lists
pages that are versions of each other.

### 3. Component Boundary Hints

Find locations where component boundaries are likely marked in the export:
- Look for `data-*` attributes that suggest structural boundaries (e.g.,
  `data-component`, `data-section`)
- Look for CSS selectors that isolate component regions
- Note markers that appear frequently or in specific patterns

For each hint, provide:
- `page`: The path to the page where the hint was found
- `selector` OR `marker`: Either a CSS selector identifying the boundary, or
  a `data-*` attribute name
- `note`: A brief description of what this boundary represents

## Output

Output a single JSON object with this structure:

```json
{
  "agentNotes": {
    "pageRoles": {
      "path/to/page.html": {
        "role": "early-version" | "demo" | "breakdown" | "other",
        "reason": "Brief explanation of the role"
      }
    },
    "versionGroups": [
      ["path/to/button-v1.html", "path/to/button-v2.html"],
      ["path/to/input-v1.html", "path/to/input-v2.html"]
    ],
    "boundaryHints": [
      {
        "page": "path/to/page.html",
        "selector": "CSS selector or element identifier",
        "note": "What this boundary represents"
      },
      {
        "page": "path/to/page.html",
        "marker": "data-attribute-name",
        "note": "What this marker suggests"
      }
    ]
  }
}
```

## Important Constraints

- **Output only the `agentNotes` key**: Do not include or restate any
  script-owned fields (`pages`, `tokens`, `variantMaps`, `assets`,
  `knownFiles`, `generatedAt`). The merge step will refuse output that
  touches these fields.
- **Page paths must match exactly**: Every path in `pageRoles` and
  `versionGroups` must correspond to a path in the report's `pages` array.
- **Markers must match the pattern `data-*`**: Names in `boundaryHints`
  using the `marker` field must match the pattern of data attributes (e.g.,
  `data-component`, `data-section`).
- **Version groups are optional**: Return an empty array if no clear versions
  are found.
- **Boundary hints are optional**: Return an empty array if no clear boundary
  markers are found.

## Guidelines

- Be conservative: only assert a version group if there are clear linguistic
  or structural indicators (e.g., "v1", "v2", "version 1", or obvious naming
  patterns)
- Prioritize high-confidence observations over speculative ones
- Use the sampled files to validate your analysis; if sampled files
  contradict the report paths, trust the report
- Page roles should reflect the most likely purpose based on available
  evidence; if uncertain, use "other"
