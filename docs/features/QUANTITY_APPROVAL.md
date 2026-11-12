# Quantity Approval, Unit Price Item Binding and Transfer to Progress Payments

The 3D (IFC) inventory or the 2D (PDF, DWG/DXF) measurement totals on the Quantities page are **approved** by the project administrator.
An approval is a numbered, immutable snapshot. The groups in the approval are **bound** to contract items, and the period progress payment (hakediş)
is filled from these bindings with **Fill From Approved Quantities**. Which progress payment came from which approval is recorded.

## Flow

1. **Approval:** **Approve Quantities** on the Quantities → 3D Model tab (selected IFC version), or **Approve Quantities**
   on the drawing's row in the 2D Drawing tab. An optional note is entered in the dialog. The "Quantity approval #n saved."
   notification comes with a **Show Approvals** link.
   - IFC: groups are broken down by class · type · material; the values are net/gross area with openings deducted, net/gross volume, length,
     weight and count. If the openings index is outdated, 409 is returned and the page prepares the index. If the model's unit could not be read (old index), the approval
     returns 409; the model must be re-indexed. Approval numbers are assigned by locking the project row (concurrent approvals do not collide).
   - 2D: groups are group name · kind (length, area, count); the cost items used in the group's measurements are stored.
     If there is an unscaled measurement, the approval is refused (400).
2. **Approvals tab** (`/projects/:pid/quantities?mode=approvals`): number, file and version, note, approved by,
   status, progress payments using it. Expanding a row shows the group table. **Revoke** asks for a reason; a revoked approval is
   kept, marked "Revoked", and cannot be used to fill a progress payment.
3. **Binding:** Contract → **Quantity Bindings** tab. Choose an approval; for each group choose an item and a measure (matching the item's unit:
   m³ → net/gross volume, m² → net/gross area, m → length, kg/ton → weight, count → count).
   **Apply Suggestions (n)** fills in the suggestions; **Save Bindings** saves. **Item Totals** shows the total of the groups
   bound to an item. Older bindings not in the selected approval are kept.
4. **Progress payment:** on the Progress Payments tab, in a draft or rejected progress payment, choose a **Quantity Approval** and click
   **Fill From Approved Quantities**. The approved quantity is treated as cumulative: this period = at least 0, (approved quantity − total of previous
   progress payments). `Quantity approval #n · file Vn · k elements` is written to the row's "Measurement Reference" field.
   The progress payment header shows "Source: quantity approval #n · file Vn"; if the approval is later revoked, an
   "Approval Revoked" badge appears next to it. A progress payment revision copies the approval link.
5. **Progress payment rules:**
   - Progress payments go for approval in order: while an earlier number is in approval, the next cannot be submitted, and once a later number has been submitted, the earlier one cannot
     be reopened. Only the latest revision is edited, submitted and approved.
   - The "previous quantity" is taken from the last approved progress payment and refreshed on submission; it is entered manually only in draft no. 1.
   - **Submit for Approval** first saves the unsaved values on the screen.
   - For a contract with a progress payment in approval or approved, the terms, currency and VAT setting cannot be changed; for an item used in a progress payment, the
     unit and unit price cannot be changed, and the item cannot be deleted (409).
   - A contract with an approved progress payment cannot be deleted; its status must first be set to **Cancelled**.
   - Status order: Approved → Invoiced → Paid. The ERP reference can also be updated on an approved progress payment.
   - The advance deduction is 0% by default and in total does not exceed the advance amount.

## Binding Suggestions

- **IFC groups:** the mapping memory of Suggest Items (`poz_mappings`, class/type/material levels). The unit price item (poz) code in memory
  is matched to the contract item's unit price item code or its code (ignoring case and punctuation).
- **2D groups:** first the cost item in the group's measurements, then a match between the group name and the item code.

Bindings are stored by group key (`["model", sınıf, tip, malzeme]` or `["drawing", grup, tür]`; class, type, material / group, kind). In later approvals of the
same model or drawing, the bindings are reused.

## Permissions

| Action | Required |
|---|---|
| Give, revoke approval | Project administrator |
| View approvals | Administrators all; others the approvals whose file they can see |
| View bindings / get suggestions | Permission to view the contract |
| Save bindings, fill a progress payment from an approval | Project administrator |

Audit log: `quantity.approved`, `quantity.approval_revoked`, `contract.quantity_bindings_updated`,
`contract.payment_filled_from_quantities`.

## Data and API

- Tables (`drizzle/0047_quantity_approvals.sql`, `src/db/schema-contracts.ts`):
  - `quantity_approvals`: sequence number within the project, source (`model` | `drawing`), version, file name, note, groups,
    totals, openings summary, status (`approved` | `revoked`), approved by, revoked by and reason.
  - `quantity_bindings`: contract, item, group key, label, source, measure. Contract + group key is unique.
  - `progress_payments.quantity_approval_id`.
- Shared calculation in `packages/shared/src/quantities/approvals.ts`: group keys, measures matching a unit, kg → ton
  conversion, item totals (`boundQuantities`).

| Endpoint | Purpose |
|---|---|
| `GET /projects/:pid/quantity-approvals?versionId=` | Approval list |
| `GET /projects/:pid/quantity-approvals/:id` | Approval and its groups |
| `POST /projects/:pid/quantity-approvals` | `{ versionId, note? }` → 201 |
| `POST /projects/:pid/quantity-approvals/:id/revoke` | `{ reason }` (required) |
| `GET /projects/:pid/contracts/:cid/quantity-bindings` | The contract's bindings |
| `PUT /projects/:pid/contracts/:cid/quantity-bindings` | `{ bindings: [{ groupKey, label, source, contractItemId, measure }] }`, replaces all |
| `GET /projects/:pid/contracts/:cid/quantity-bindings/suggest?approvalId=` | Binding suggestions |
| `POST /projects/:pid/contracts/:cid/payments/:payId/fill-from-quantities` | `{ approvalId }` |

Errors: revoked approval 400; no bindings 400 (points to the "Quantity Bindings" tab); an item from another contract,
a measure that does not match the unit, or a duplicated group 400.

## Tests

- `packages/shared/test/approvals.test.ts`: keys, measures by unit, kg → ton, item totals, missing measure.
- `apps/server/test/quantities/approvals-api.test.ts`: administrator-only approval, IFC groups and net area, visibility,
  filling without bindings 400, suggestion from memory, measure validation, filling (only the increase over the cumulative), revoking, 2D approval
  and suggestion from the cost item.
- `e2e/specs/quantity-approvals.spec.ts` (desktop): approval dialog, Approvals tab and groups, Quantity Bindings,
  filling the progress payment and its source, revoking with a reason.
- `e2e/specs/mobile-quantity-approvals.spec.ts` (iPhone): approval, binding and filling by tapping; no horizontal scrolling.
- `e2e/specs/mobile-smoke.spec.ts`: `quantities?mode=approvals`.

## Not Yet Available

- The Ask (MCP) tool does not read approvals.
- Partial approval by storey/zone (progress percentage); an approval always covers the whole model or drawing.
- A multi-step (check → approve) workflow; it is a single-step administrator approval.
