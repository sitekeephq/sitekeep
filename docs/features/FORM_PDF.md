# Form Template from PDF and Described Approval Workflow

The official paper form the customer uses is uploaded as a PDF. The system finds the fields.
The user describes the workflow in plain Turkish. The result is a normal form template with an approval workflow attached.
The filled-in form is output in the uploaded PDF's own layout.

## How it works

1. **Forms → Templates → Create Template from PDF.** Choose a PDF (at most 30 MB, first 20 pages).
2. The server stores the PDF and searches for fields. The result is a draft; it is not saved yet.
3. The **Fields** screen shows the PDF pages and the field boxes, with the field list alongside.
   - Clicking a box selects it in the list; clicking in the list selects it on the page.
   - A box is moved by dragging and resized with the bottom-right handle.
   - **Draw Field** adds a new field by dragging on the page.
   - Name, type, required flag and section are changed in the list. For tables, the number of rows on the page is entered.
   - To delete, use **Delete** or the Delete key. Arrow keys move the box by 1 pt (10 pt with Shift).
   - **Undo** (Ctrl+Z) undoes the latest changes.
4. **Name with AI** is optional. Only a short field list is sent to the model, not the PDF.
   The model suggests the name, type and section; the box positions do not change.
5. **Save.** The template is a normal, versioned form template. Each version keeps the source PDF.
   A change made after a form has used the template opens a new version; older forms stay with the older version.
6. On the **Approval Workflow** tab, the workflow is described or set up manually, then saved.

## Field detection levels

| Level | When | How |
|---|---|---|
| Fillable PDF (AcroForm) | The PDF has form fields | Fields are read as they are: name, type, options, page and box. The most reliable level. |
| PDF with a text layer | No fields, but the text is selectable | Labels and blanks are found by rules. Also works when AI is turned off. |
| Scanned PDF | No text layer | No fields can be found. A clear message is shown; fields are drawn on the page manually. |

Markers searched for in the text layer:

- Dotted or underscored blanks such as `Proje Adı: ..........` (Project Name) and `Tarih: ______` (Date).
- A line next to a label (when `Döküm Yeri: ________` (Pouring Location) is drawn as a line).
- Signature lines with a label underneath (`Hazırlayan İmza` (Prepared By Signature), `Kontrol Eden İmza` (Checked By Signature)).
- Boxes with a label inside or above (`Açıklama` (Notes), `Kaşe` (Stamp)).
- Checkboxes: `☐ Evet ☐ Hayır` (Yes / No) becomes a single Yes/No item; other labels become a choice.
- `Evet Hayır` text without boxes.
- Table grids: a grid with a filled header and empty rows becomes a repeating table.
  A label–value grid (label on the left, empty cell on the right) becomes separate fields.
- A label ending in `:` with a blank to its right.
- The type is derived from the label: date, signature/stamp, photo/sketch, km, number with a unit (`(m³)`, `(mm)`), notes (multi-line).
- Sections: short lines in capitals or in a larger font.

Scanned PDFs need a vision model (e.g. Qwen2.5-VL on Ollama) or OCR.
The `VisionFieldDetector` interface is ready on the server (`apps/server/src/forms/pdf-detect.ts`).
When a model is connected, it receives the page images and returns candidate fields in the same format.

## Describing the workflow

Example description:

> Formu şantiye şefi doldurur, kalite kontrol mühendisi kontrol eder; ret olursa yükleniciye geri döner;
> onaylanınca müşavire bilgi gider; 3 gün içinde cevap verilmeli; imza alanlarını onaylayan kişi doldurur.

(The site manager (şantiye şefi) fills in the form, the quality control engineer checks it; if rejected, it goes back to the
contractor; once approved, the consultant is informed; a reply is due within 3 days; the approver fills in the signature fields.)

Resulting steps:

```
1. Şantiye Şefi doldurur
2. Kalite Kontrol Mühendisi kontrol eder (Onay → kapanır; Ret → 1. adıma döner) · 3 gün · Doldurur: Kontrol Eden İmza
Onaylanınca bilgi: Müşavir
Durum: onaylanınca Kapalı; iade veya retle doldurana dönerse Taslak
```

(1. Site Manager fills in. 2. Quality Control Engineer checks (Approve → closes; Reject → back to step 1) · 3 days ·
Fills in: Checked By Signature. Informed on approval: Consultant. Status: Closed on approval; Draft if returned or
rejected back to the filler.)

Other examples:

- "Formu formen doldurur, şantiye şefi kontrol eder, proje müdürü onaylar; müdür reddederse şantiye şefine döner."
  (The foreman fills in, the site manager checks, the project manager approves; if the manager rejects, it goes back
  to the site manager.) Three steps result; the rejection in step 3 returns to step 2.
- "Teknik ofis doldurur, müşavir görür." (The technical office fills in, the consultant sees it.) The consultant step
  has only the "Noted" reply.

Rules:

- The model only produces a small JSON. The rest is done by rules and validated with zod.
- An invalid answer is sent back once with the error list for correction. If it still fails, a clear error message is returned.
- Names are matched against the project's roles, companies and people. An unmatched name appears in the "Roles Not in the Project" box.
  **Create Role** creates the role; **Match** links it to an existing role, company or person. It cannot be saved until matched.
- "Proje yöneticisi" (project administrator) becomes the built-in role. "Formu dolduran" (the form filler) is the person who starts the workflow.
- The saved workflow is a normal approval workflow template (type: Form Approval). The same screen is used for manual setup.
- If AI is turned off, **Set Up Manually** lets you choose the steps, assignees, replies, return step, duration and fields.

## Field permissions (on the server)

- A field given to a step is filled only by that step's assignee, and only at that step.
- The filler cannot change these fields; trying to send a value or attachment returns 403.
- These fields are not required from the filler. They must be filled before the step is approved.
- The assignee saves the fields with `PATCH /forms/:id/step-values`; they cannot touch other fields.
- Only those chosen as "filler" in the workflow can open the form (everyone, if empty).
- A rejection returns to the earlier step chosen in the step (new round) or returns to the filler as a draft.

## Output (PDF)

- For templates with a source PDF, the output is written onto the uploaded PDF.
- In a fillable PDF, checkboxes and radio buttons are ticked with the PDF's own mark.
  Text is written into the box after the PDF is flattened (Liberation Sans; full Turkish character support).
- In other PDFs, text is written at a size that fits the box; long text wraps onto new lines.
- Checkboxes get a tick drawn in them, the signature image fits into its box, and dates use the format dd.mm.yyyy.
- Table rows are written into the grid. Rows that do not fit go onto an extra page with a "continued" heading.
- Photos are collected on extra pages.
- The approval stamp (step, person, date, result) is placed in the page's empty margin. If there is no room, on an extra page.
- The form number is written in the top margin of page 1 if there is room.
- Templates without a source PDF use the older generic output.

## Filling in

- The Fill Form screen is the same; it works on a phone and offline.
- **PDF View** shows the values on the form's own PDF. The PDF is stored in the browser and also opens offline.
- Tapping a field goes to that item in the form view.
- The person at an approval step fills in their own fields (e.g. signature), then replies. This step needs a connection.

## Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/projects/:pid/form-templates/pdf` | Upload a PDF, find the fields (returns a draft) |
| GET | `/projects/:pid/form-pdf-sources/:sid` · `/file` | Source PDF information · file |
| POST | `/projects/:pid/form-templates/name-fields` | Name the fields with the local model |
| POST | `/projects/:pid/form-templates/flow/generate` | Workflow draft from a description |
| GET · PUT · DELETE | `/projects/:pid/form-templates/:tid/flow` | The template's workflow |
| PATCH | `/projects/:pid/forms/:fid/step-values` | The step owner's fields |
| POST | `/projects/:pid/forms/:fid/review` | Custom reply with `code` (e.g. `RET`) |

MCP: `cde_form_templates_list` returns the template's source (PDF) and workflow steps.
`cde_form_template_from_description` creates a template and workflow from a description (write key, project administrator).

## Limits

- No automatic field detection on scanned PDFs (no vision model installed).
- Rotated pages and per-page crop boxes have not been tested.
- Encrypted (password-protected) PDFs are not accepted.
- The rules find common layouts; for complex forms, the boxes need to be checked and corrected.
- Merged cells in a table may be read as a single column.
- To change the PDF of an existing template, a new PDF template is created (fields are not mapped).
- A local 8B model is slow on a CPU; workflow generation and naming can take a few minutes.
- Signatures and fields at an approval step are not saved offline.
