# Suggest Items

Suggests unit price items (poz) from the project's unit price list for element groups in the IFC model. An accepted row becomes an ordinary
cost rule (5D) and is written to memory; in later projects it is suggested first for the same group.
Principle: the model calculates quantity and amount; the AI only picks an item code from the given candidate list; a suggestion that is not
accepted never enters any total.

## Where to open it

- **Quantities** page → **Suggest Items** (for the selected version).
- **Schedule → More → Cost (5D) → Cost Rules** → **Suggest Items** (for the selected model).
- **Cost (5D) → Learned Mappings**: the memory.
- Only users with planning permission (project manager) see it. If the Schedule module is off, the button does not appear.

## How it works

1. **Groups.** Elements are grouped by the class · type · material triple.
   - For each group a rule that selects exactly those elements is searched for, in this order: `Class + Type = …`, `Class + Material = …`, `Class` only.
   - If none selects exactly, the group stays without a suggestion as "cannot be singled out by one rule". Example: the same class has other elements with no type and no material.
   - Groups containing an element already priced by an existing cost rule are skipped and added to the "already priced" count.
2. **Quantity.** The item's unit determines the quantity source:
   - m³ → net volume (gross volume if missing)
   - m² → net area (NetSideArea for walls)
   - m → length
   - kg → weight
   - ton → weight × 0.001
   - adet (each) → element count

   The sources are the same as in the quantity take-off (metraj) inventory (`Qto_*`, Revit "Dimensions" fallback). If the group has no quantity in that unit, the item cannot be a candidate.
3. **Sources** (in order of priority):
   - **Learned:** a previously accepted group ↔ item mapping. Match levels and confidence:
     - Same class, type and material: 95%
     - Same type: 85%
     - Same material: 75%
     - Class only: 60%

     Each earlier approval raises the confidence a little. The item is found in this project's list by item number (by code if there is none); the line item code in another project may differ.
   - **AI:** the project's AI provider.
     - For each group, at most 8 candidates selected by keyword are sent with their descriptions; the model picks only one of them.
     - A code not in the list, an unknown group or a unit for which the group has no quantity is discarded.
     - If the response cannot be read or AI is off, a warning is shown; learned and keyword suggestions continue.
     - Each call is written to the audit log as `ai.poz_suggest`.
   - **Keywords:** the item description is searched for class words ("duvar", "döşeme", "kolon", "kiriş", "kapı", "pencere"… — wall, slab, column, beam, door, window), material words ("beton", "c30", "gazbeton"… — concrete, C30, aerated concrete) and type words.
     - A suitable unit (m³ for reinforced concrete, adet for doors / windows, m² for masonry walls) raises the score.
     - The rationale lists the matched words.
4. **Approval.**
   - The user can change a row's item; quantity and amount are recalculated.
   - The user can remove the row or click **Reject**. A rejected item is not suggested again for that group.
   - **Turn Selected into Rules** turns the selected rows into cost rules and writes them to memory. If the same mapping is accepted again, its approval count increases.
   - Audit log: `cost.poz_suggestions_accepted`, with the breakdown by source.

## Memory (Learned Mappings)

- Table `poz_mappings` (migration `0045_poz_mappings`).
- Row fields: class, folded type and material key, item no., description, unit, quantity source, decision (accepted / rejected), approval count, last project.
- Shared across all projects in the installation.
- A row belongs to the project where it was first learned. If the same mapping is accepted again in another project, only the approval count increases;
  another project cannot change the row's decision, quantity source or owner (except a system administrator). A project's
  rejection only hides the suggestion in that project.
- The planner sees the list. Only a planner of the owning project or a system administrator can delete a row; rows that cannot be deleted
  show no ✕ (`deletable`).
- Deleting does not change existing cost rules.

## API

| Method | Path | Note |
|---|---|---|
| POST | `/projects/:pid/cost-rules/suggest` | `{ versionId, ai? }` → suggestions, groups without a suggestion, `covered`, `ai { used, model?, error? }` |
| POST | `/projects/:pid/cost-rules/suggest/accept` | `{ versionId, suggestions: [{ class, type, material, match, costItemId, quantity, multiplier, source }] }` → created rules |
| POST | `/projects/:pid/cost-rules/suggest/reject` | `{ class, type, material, costItemId }` |
| GET | `/projects/:pid/poz-mappings` | memory (last 500) |
| DELETE | `/projects/:pid/poz-mappings/:id` | planner of the same project or system administrator |

Code: Cost module ([sitekeep-cost](../modules/cost.md)) `server/fived/poz.ts` (groups, scoring, memory,
AI), `server/fived/routes.ts`, `web/fived/PozSuggest.tsx`; shared types `packages/shared/src/schedule/poz.ts`.

## Tests

- Unit: `apps/server/test/simulation/poz.test.ts`.
  - Groups and the exact rule.
  - Unit → quantity mapping.
  - Keyword selection and amount.
  - Rejection.
  - Memory levels and cross-project item number matching.
  - AI selection with a fake provider, discarding an invented code and an unreadable response.
- API: `apps/server/test/simulation/poz-api.test.ts`.
  - Keywords when there is no provider.
  - Planner only.
  - Accept → rule, preview total and audit log.
  - Rejection.
  - Memory and approval count in another project.
  - AI with a fake local model and fallback on a broken response.
  - Permission to delete a mapping.
- E2E (desktop): `e2e/specs/poz-suggest.spec.ts`.
  - Quantities → Suggest Items.
  - Changing an item, rejection, selection total, turning into rules.
  - "Learned" in a second project.
  - Cost (5D) rules and deletion from Learned Mappings.
- E2E (iPhone): `e2e/specs/mobile-poz-suggest.spec.ts`. Card view, no horizontal scroll, turning a single row into a rule.
- Fixture: `apps/server/test/fixtures/poz.ifc`.
  - Shear wall and aerated concrete wall types.
  - Door and window types.
  - A window without a type (a group that cannot be singled out).
  - Railing (no suitable item).

## Limitations

- A rule carries a single property condition. Elements of the same type with different materials are separate groups, but a type rule selects both; in that case material or class is tried, and if that fails the group stays without a suggestion.
- Memory is carried by item number; if the item number is empty in the lists, only the same line item code matches.
