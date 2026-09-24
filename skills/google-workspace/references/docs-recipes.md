# Docs recipes — raw `batch_update_docs_raw` requests

All requests go in `batch_update_docs_raw({ documentId, requests: [ ... ] })`.

**The Docs body is 1-based.** Index 1 = the first character of the body. Every `insertText` shifts
all following content by its length, so:

- **Apply multiple inserts back-to-front** (highest index first) in one batch, OR
- insert one piece, re-`get_document` (`includeRaw=true` for exact endIndex), then insert the next.

Get exact indexes from `get_document({ includeRaw: true })` — `raw.content[].endIndex`. Append
target = last element's `endIndex - 1` (you cannot write past the body's trailing newline).
For simple appends/inserts/replaces, prefer the high-level `append_text` / `insert_text` /
`replace_text` tools; drop to raw for styling and structure.

---

## Heading — insert text then style the paragraph

Insert first, then style the just-written range. `namedStyleType`: `HEADING_1`…`HEADING_6`,
`NORMAL_TEXT`, `TITLE`, `SUBTITLE`.

```json
[
  {"insertText": {"location": {"index": 1}, "text": "Quarterly Report\n"}},
  {"updateParagraphStyle": {
    "range": {"startIndex": 1, "endIndex": 17},
    "paragraphStyle": {"namedStyleType": "HEADING_1"},
    "fields": "namedStyleType"
  }}
]
```

## Bulleted list

Insert the lines (each ending `\n`), then turn the whole span into bullets.

```json
[
  {"insertText": {"location": {"index": 1}, "text": "First\nSecond\nThird\n"}},
  {"createParagraphBullets": {
    "range": {"startIndex": 1, "endIndex": 19},
    "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE"
  }}
]
```
Numbered list: `bulletPreset` = `NUMBERED_DECIMAL_ALPHA_ROMAN`.

## Bold / italic / colored text run

```json
[{"updateTextStyle": {
  "range": {"startIndex": 1, "endIndex": 10},
  "textStyle": {"bold": true, "italic": true,
    "foregroundColor": {"color": {"rgbColor": {"red": 0.8, "green": 0.1, "blue": 0.1}}}},
  "fields": "bold,italic,foregroundColor"
}}]
```

## Hyperlink a range

```json
[{"updateTextStyle": {
  "range": {"startIndex": 1, "endIndex": 13},
  "textStyle": {"link": {"url": "https://example.com"}},
  "fields": "link"
}}]
```

## Insert a table (2×3), then fill cells

`insertTable` creates the grid at `location`. **After insertion, cell text indexes shift** — the
first cell's paragraph starts a few indexes after the table's insert point. Safest pattern: insert
the table, re-`get_document({ includeRaw: true })`, read each cell's `startIndex`, then insert cell
text **back-to-front** (last cell first) so earlier indexes stay valid.

```json
[{"insertTable": {"location": {"index": 1}, "rows": 2, "columns": 3}}]
```
Then, in a second batch (indexes from the re-read, descending):
```json
[
  {"insertText": {"location": {"index": 25}, "text": "r2c3"}},
  {"insertText": {"location": {"index": 20}, "text": "r2c2"}},
  {"insertText": {"location": {"index": 15}, "text": "r2c1"}},
  {"insertText": {"location": {"index": 10}, "text": "r1c3"}},
  {"insertText": {"location": {"index": 6},  "text": "r1c2"}},
  {"insertText": {"location": {"index": 2},  "text": "r1c1"}}
]
```

## Inline image from a public URL

```json
[{"insertInlineImage": {
  "location": {"index": 1},
  "uri": "https://example.com/logo.png",
  "objectSize": {
    "width":  {"magnitude": 200, "unit": "PT"},
    "height": {"magnitude": 100, "unit": "PT"}
  }
}}]
```
The URL must be publicly reachable; Docs fetches and copies it (≤50 MB, ≤25 MP, PNG/JPG/GIF).

## Page break

```json
[{"insertPageBreak": {"location": {"index": 1}}}]
```

## Template pattern — `{{placeholder}}` fill

Build a template doc containing `{{name}}`, `{{date}}`, `{{total}}`. Copy it (Drive), then fill with
one batch of `replaceAllText` — order-independent, no index math:

```json
[
  {"replaceAllText": {"containsText": {"text": "{{name}}",  "matchCase": true}, "replaceText": "Acme s.r.o."}},
  {"replaceAllText": {"containsText": {"text": "{{date}}",  "matchCase": true}, "replaceText": "24.9.2026"}},
  {"replaceAllText": {"containsText": {"text": "{{total}}", "matchCase": true}, "replaceText": "12 500 Kč"}}
]
```
Or just call the `replace_text` tool once per placeholder. This is the most robust way to generate
docs from a template — no index bookkeeping.
