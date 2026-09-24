# Slides recipes — layout, EMU and raw `batch_update_slides_raw`

High-level tools cover most needs: `add_slide` (layout + auto-filled title/body), `insert_text_box`,
`insert_image`, `replace_text_in_presentation`, `delete_slide`, `get_slide_thumbnail`. Drop to
`batch_update_slides_raw({ presentationId, requests: [ ... ] })` for notes, styling, tables, precise
placement.

## EMU & geometry

- **914400 EMU = 1 inch = 96 px. 12700 EMU = 1 pt.**
- Default 16:9 page = **9144000 × 5143500 EMU** (10 in × 5.625 in).
- Position is `translateX` / `translateY` from the top-left corner; size is `width` / `height`.
- `insert_text_box` / `insert_image` take `widthEmu`, `heightEmu`, `translateXEmu`, `translateYEmu`
  (defaults: 4×1 in box at 1 in, 1 in).

### Thirds grid (16:9) — handy anchor points, in EMU

| | Left third x=0 | Center third x=3048000 | Right third x=6096000 |
|---|---|---|---|
| Top third y=0 | (0, 0) | (3048000, 0) | (6096000, 0) |
| Middle y=1714500 | (0, 1714500) | (3048000, 1714500) | (6096000, 1714500) |
| Bottom y=3429000 | (0, 3429000) | (3048000, 3429000) | (6096000, 3429000) |

Each cell is 3048000 × 1714500 EMU. Example: a title box across the top third —
`insert_text_box({ ..., widthEmu: 9144000, heightEmu: 1714500, translateXEmu: 0, translateYEmu: 0 })`.

## Predefined layouts (`add_slide` `layout` enum)

`BLANK`, `CAPTION_ONLY`, `TITLE`, `TITLE_AND_BODY`, `TITLE_AND_TWO_COLUMNS`, `TITLE_ONLY`,
`SECTION_HEADER`, `SECTION_TITLE_AND_DESCRIPTION`, `ONE_COLUMN_TEXT`, `MAIN_POINT`, `BIG_NUMBER`.

`add_slide` auto-fills placeholder types `TITLE`/`CENTERED_TITLE` (from `title`) and `BODY`/`SUBTITLE`
(from `body`). `get_presentation` reports each element's `placeholderType` so you can target others.

## Add a title+body slide, then a two-column slide

```
add_slide({ presentationId, layout: "TITLE",         title: "Q3 Review", body: "Company internal" })
add_slide({ presentationId, layout: "TITLE_AND_BODY", title: "Highlights", body: "- Revenue up\n- Churn down" })
```
Body bullets: newlines become separate paragraphs; the layout's list style renders them as bullets.

## Speaker notes (raw — the high-level tools can't)

`get_presentation` shows notes **text** but not the notes shape id. Get the id from the raw page:

1. `get_presentation({ presentationId, includeRaw: true })` → for the slide, read
   `raw.slides[i].slideProperties.notesPage.notesProperties.speakerNotesObjectId`.
2. Insert into that shape:

```json
[{"insertText": {"objectId": "SPEAKER_NOTES_OBJECT_ID", "text": "Pause here. Mention the pilot.", "insertionIndex": 0}}]
```

## Style a text run (raw)

```json
[{"updateTextStyle": {
  "objectId": "SHAPE_ID",
  "textRange": {"type": "ALL"},
  "style": {"bold": true, "fontSize": {"magnitude": 24, "unit": "PT"},
    "foregroundColor": {"opaqueColor": {"rgbColor": {"red": 0.1, "green": 0.2, "blue": 0.5}}}},
  "fields": "bold,fontSize,foregroundColor"
}}]
```

## Precise element placement (raw createShape)

```json
[
  {"createShape": {"objectId": "box1", "shapeType": "TEXT_BOX",
    "elementProperties": {
      "pageObjectId": "SLIDE_OBJECT_ID",
      "size": {"width": {"magnitude": 3048000, "unit": "EMU"}, "height": {"magnitude": 1714500, "unit": "EMU"}},
      "transform": {"scaleX": 1, "scaleY": 1, "translateX": 6096000, "translateY": 3429000, "unit": "EMU"}
    }}},
  {"insertText": {"objectId": "box1", "text": "Bottom-right", "insertionIndex": 0}}
]
```

## Template pattern — build once, duplicate, replace

Make a template deck with `{{client}}`, `{{quarter}}`, `{{arr}}` on the slides. Copy it (Drive),
then fill:

```
replace_text_in_presentation({ presentationId, find: "{{client}}",  replace: "Acme" })
replace_text_in_presentation({ presentationId, find: "{{quarter}}", replace: "Q3 2026" })
replace_text_in_presentation({ presentationId, find: "{{arr}}",     replace: "1,2M Kč" })
```
Scope to specific slides with `pageObjectIds: ["slide_id"]`.

## Verify visually

After building, call `get_slide_thumbnail({ presentationId, slideObjectId })` and open the returned
`contentUrl` (temporary PNG, expires ~30 min) to check layout before handing off.
