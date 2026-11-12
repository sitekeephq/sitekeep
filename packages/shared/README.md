# `@sitekeep/shared`

`src/index.ts` is the package's stable public facade. Applications should import from
`@sitekeep/shared`; source-path imports are reserved for package-internal tests.

## Ownership

- `kernel/`: dependency-light permissions, naming, attributes, and text helpers
- `core/`: base DTOs and project-module state/catalog
- `workflow/`, `works/`, `forms/`: their respective business contracts and pure helpers
- `documents/`, `coordination/`, `viewers/`, `reports/`, `schedule/`: feature-domain contracts
- `platform/`: cross-cutting OAuth, privacy, templates, terms, locations, hub, and AI presets

## Dependency direction

Leaf primitives (`kernel/`, `core/module-state.ts`, `workflow/assignee-types.ts`, and
`forms/form-constants.ts`) must not import higher-level domains. Domain implementations may
depend on leaf primitives and peer contracts, while catalogs that map domains (for example
project modules to work categories) sit downstream. Internal files import concrete leaf modules,
not directory barrels; only the root barrel defines the public facade.
