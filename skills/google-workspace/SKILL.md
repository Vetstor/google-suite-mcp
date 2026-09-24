---
name: google-workspace
description: Use when working with Google Sheets, Docs, Slides, Forms or Apps Script through the Google Workspace MCP connector — reading/writing cells, formatting via raw batchUpdate, building docs/decks/forms, reading form responses, writing bound Apps Script. Covers index math, EMU layout, recipes and gotchas.
---

# Google Workspace MCP

48 tools over Sheets, Docs, Slides, Forms, Apps Script + Drive listing. Tools surface as
`mcp__<serverid>__<tool>`; this doc uses bare names (`read_range`, `batch_update_raw`, …).

## Golden workflow rules

1. **Read metadata first.** Before touching any file, call the matching getter to learn ids,
   sheetIds, indexes and existing structure:
   - Sheets → `get_spreadsheet` (returns `sheets[].properties.sheetId` — the numeric id every raw
     request needs). **Never guess a sheetId; 0 is only the default first tab.**
   - Docs → `get_document` (text + `revisionId`; use `includeRaw=true` when you need exact indexes).
   - Slides → `get_presentation` (slide `objectId`s, element ids, placeholder types).
   - Forms → `get_form` (itemIds, question types). Apps Script → `get_script_project`.
2. **URLs are fine.** Every id param accepts a full Google URL; the server extracts the id.
3. **Batch, don't drip.** One `batch_write` / one `batch_update_raw` with N requests beats N calls.
   Sheets quota is ~300 req/min/project — batching is correctness, not just speed.
4. **Reads:** use `asObjects=true` on `read_range` for tabular data (row 1 = headers → array of
   objects). Read specific ranges, never a whole giant sheet. For math use
   `valueRenderOption=UNFORMATTED_VALUE` (FORMATTED_VALUE returns display strings like "1 234 Kč";
   FORMULA returns the `=…` text).
5. **Writes:** default `valueInputOption=USER_ENTERED` so `=SUM()`, dates and numbers parse. Use
   `RAW` only to store a literal string that looks like a formula/number.
6. **A1 quoting:** sheet names with spaces need single quotes — `'Sales 2026'!A1:D10`.
7. **Escape hatch:** anything the high-level tools don't cover goes through the raw batchUpdate tool
   for that product (`batch_update_raw`, `batch_update_docs_raw`, `batch_update_slides_raw`,
   `batch_update_forms_raw`). The recipes below are ready-to-paste `requests` arrays.

## Index & coordinate math (memorize this)

- **Sheets GridRange is 0-based, half-open:** `startRowIndex:0, endRowIndex:1` = row 1 only.
  `startColumnIndex:0, endColumnIndex:3` = columns A–C. Omit an end to run to the sheet edge.
  Every GridRange carries the numeric `sheetId`.
- **Docs body is 1-based;** index 1 = first character. `insertText` shifts everything after it, so
  **apply multiple inserts back-to-front (descending index)** or all in one batch ordered high→low.
  Append target = last element's `endIndex - 1`.
- **Slides geometry is EMU:** 914400 EMU = 1 inch = 96 px; 12700 EMU = 1 pt. Default 16:9 page is
  9144000 × 5143500 EMU. Position with `translateX/Y` from the top-left.

## Tool cheat-sheet by product

- **Sheets values:** `read_range`, `batch_read`, `write_range`, `batch_write`, `append_rows`
  (finds first empty row), `clear_range` (values only, keeps format), `find_cells` (client-side,
  ≤200 hits). **Structure:** `create_spreadsheet`, `add_sheet`, `delete_sheet`, `batch_update_raw`.
- **Docs:** `create_document`, `get_document`, `append_text` (+ optional heading), `insert_text`,
  `replace_text`, `batch_update_docs_raw`.
- **Slides:** `create_presentation`, `get_presentation`, `add_slide` (predefined layout + auto-fill
  title/body), `insert_text_box`, `insert_image` (public URL), `replace_text_in_presentation`,
  `delete_slide`, `get_slide_thumbnail` (temp PNG, ~30 min), `batch_update_slides_raw`.
- **Forms:** `create_form`, `get_form`, `add_question`, `update_form_info`, `delete_item`,
  `list_responses`, `batch_update_forms_raw`.
- **Apps Script:** `create_script_project`, `get_script_project`, `update_script_content`,
  `create_script_version`, `create_script_deployment`, `list_script_*`, `run_script_function`,
  `get_script_processes`.
- **Drive listing:** `list_spreadsheets`, `list_documents`, `list_presentations`, `list_forms`,
  `list_script_projects` — all name **substring** searches; pass `folderId` to scope.

## Recipe references (raw JSON lives here)

- **Sheets formatting & structure** → [references/sheets-recipes.md](references/sheets-recipes.md):
  header style + freeze, Czech number/date formats, autosize, conditional formatting (boolean +
  gradient), dropdown validation, protected & named ranges, chart, pivot, merge, column width,
  hide gridlines, insert/delete rows/cols, sort, borders.
- **Docs authoring** → [references/docs-recipes.md](references/docs-recipes.md): headings, bullets,
  tables, links, inline images, page breaks, `{{placeholder}}` templating.
- **Slides layout** → [references/slides-recipes.md](references/slides-recipes.md): EMU/layout
  reference, thirds grid, speaker notes via raw, template fill.

## Forms flow

1. `create_form` → `{formId, responderUri, editUrl}`.
2. Loop `add_question` (`SHORT_TEXT`, `PARAGRAPH`, `MULTIPLE_CHOICE`, `CHECKBOXES`, `DROPDOWN`,
   `LINEAR_SCALE`, `DATE`, `TIME`). Choice types need `options[]`; `LINEAR_SCALE` needs
   `scale:{low,high,lowLabel?,highLabel?}`. Appends by default; pass 0-based `index` to place.
3. Share the `responderUri` with respondents.
4. `list_responses` returns rows keyed by **question title**; CHECKBOX answers come back as arrays.
   Filter with `"timestamp > 2026-01-01T00:00:00Z"`. Response timestamps are UTC — Prague is
   UTC+1/+2, convert when displaying.
5. **Linking responses to a Sheet cannot be done via the API** — tell the user to open the form's
   Responses tab and click "Link to Sheets" in the UI (`https://docs.google.com/forms/d/<id>/edit`).

## Apps Script flow (bound script)

1. `create_script_project` with `parentId` = the Sheet/Doc/Form/Slides id → container-bound script.
   Returns `{scriptId, editorUrl}`.
2. `update_script_content` with your `.gs` file(s). It **merges** by name and always keeps the
   `appsscript` manifest. Minimal manifest + a bound function that reads a sheet:
   ```json
   [
     {"name":"appsscript","type":"JSON","source":"{\n  \"timeZone\": \"Europe/Prague\",\n  \"exceptionLogging\": \"STACKDRIVER\",\n  \"runtimeVersion\": \"V8\"\n}"},
     {"name":"Code","type":"SERVER_JS","source":"function readFirstColumn() {\n  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];\n  return sh.getRange(1, 1, sh.getLastRow(), 1).getValues().flat();\n}"}
   ]
   ```
3. Tell the user: **open `editorUrl` and Run the function once** to grant authorization (the API
   cannot trigger the consent dialog). Give them the link directly.
4. `run_script_function` is **constrained**: it only works when the script's GCP project matches
   this server's OAuth client project **and** the script has an "API Executable" deployment; most
   user scripts return 403/404. Each user must also enable the Apps Script API once at
   `https://script.google.com/home/usersettings`. For scheduled runs prefer an Apps Script
   time-driven trigger set up in the editor.

## Gotchas

- **403 / PERMISSION_DENIED** = the file isn't shared with the signed-in user, or scopes went stale
  after a `SCOPE_VERSION` bump → have the user reconnect the connector in claude.ai settings.
- **`list_*` are name-contains searches**, not fuzzy and not folder-recursive — pass `folderId` to
  scope, and expect substring (not typo-tolerant) matching.
- **Rate limits:** Sheets ~300 req/min/project → collapse work into `batch_*` calls.
- **Large sheets:** read targeted ranges; a whole-sheet read can blow the response size.
- **Slides speaker notes:** `get_presentation` shows notes text but not the notes shape id — call
  `get_presentation` with `includeRaw=true` (or the raw page) to get
  `slideProperties.notesPage.notesProperties.speakerNotesObjectId`, then `insertText` into it via
  `batch_update_slides_raw`. See the slides reference.
- **Insert order in Docs:** forgetting to go back-to-front corrupts every later index — one wrong
  insert cascades. When unsure, re-`get_document` between batches.
