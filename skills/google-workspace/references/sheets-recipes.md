# Sheets recipes — raw `batch_update_raw` requests

All requests go in `batch_update_raw({ spreadsheetId, requests: [ ... ] })`.
Replace `SHEET_ID` with the numeric `sheetId` from `get_spreadsheet` (NOT the tab name).

**GridRange is 0-based, half-open:** `startRowIndex:0,endRowIndex:1` = row 1;
`startColumnIndex:0,endColumnIndex:3` = A–C. Omit an end index to extend to the sheet's edge.
Colors are 0–1 floats (`{"red":0.2,"green":0.4,"blue":0.8}`), not 0–255.

---

## Header row: bold + background + white text, then freeze row 1

```json
[
  {"repeatCell": {
    "range": {"sheetId": SHEET_ID, "startRowIndex": 0, "endRowIndex": 1},
    "cell": {"userEnteredFormat": {
      "backgroundColor": {"red": 0.17, "green": 0.24, "blue": 0.31},
      "horizontalAlignment": "CENTER",
      "textFormat": {"foregroundColor": {"red": 1, "green": 1, "blue": 1}, "bold": true}
    }},
    "fields": "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)"
  }},
  {"updateSheetProperties": {
    "properties": {"sheetId": SHEET_ID, "gridProperties": {"frozenRowCount": 1}},
    "fields": "gridProperties.frozenRowCount"
  }}
]
```

## Number & date formats (Czech locale)

`type` is one of `NUMBER | CURRENCY | PERCENT | DATE | TIME | DATE_TIME`. The `pattern` is what
matters. Apply to a column with `repeatCell` (start at row 1 to skip the header).

```json
[
  {"repeatCell": {
    "range": {"sheetId": SHEET_ID, "startRowIndex": 1, "startColumnIndex": 2, "endColumnIndex": 3},
    "cell": {"userEnteredFormat": {"numberFormat": {"type": "CURRENCY", "pattern": "#,##0 \"Kč\""}}},
    "fields": "userEnteredFormat.numberFormat"
  }}
]
```

Common Czech patterns: currency `#,##0 "Kč"` · percent `0.0%` · date `d.M.yyyy` ·
datetime `d.M.yyyy H:mm` · thousands `# ##0` (Google renders the grouping per locale).

## Autosize columns to content

```json
[{"autoResizeDimensions": {"dimensions": {"sheetId": SHEET_ID, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 6}}}]
```

## Set explicit column width (pixels)

```json
[{"updateDimensionProperties": {
  "range": {"sheetId": SHEET_ID, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 1},
  "properties": {"pixelSize": 220}, "fields": "pixelSize"
}}]
```

## Conditional formatting — boolean rule (highlight where C > 1000)

```json
[{"addConditionalFormatRule": {
  "index": 0,
  "rule": {
    "ranges": [{"sheetId": SHEET_ID, "startRowIndex": 1, "startColumnIndex": 2, "endColumnIndex": 3}],
    "booleanRule": {
      "condition": {"type": "NUMBER_GREATER", "values": [{"userEnteredValue": "1000"}]},
      "format": {"backgroundColor": {"red": 0.85, "green": 0.95, "blue": 0.85}}
    }
  }
}}]
```
Other `condition.type` values: `TEXT_CONTAINS`, `NUMBER_BETWEEN` (two values), `TEXT_EQ`,
`CUSTOM_FORMULA` (`values:[{"userEnteredValue":"=$C2>$B2"}]`), `NOT_BLANK`.

## Conditional formatting — 3-color gradient (green→yellow→red)

```json
[{"addConditionalFormatRule": {
  "index": 0,
  "rule": {
    "ranges": [{"sheetId": SHEET_ID, "startRowIndex": 1, "startColumnIndex": 2, "endColumnIndex": 3}],
    "gradientRule": {
      "minpoint": {"color": {"red": 0.34, "green": 0.73, "blue": 0.54}, "type": "MIN"},
      "midpoint": {"color": {"red": 0.99, "green": 0.85, "blue": 0.46}, "type": "PERCENTILE", "value": "50"},
      "maxpoint": {"color": {"red": 0.92, "green": 0.49, "blue": 0.45}, "type": "MAX"}
    }
  }
}}]
```
`type`: `MIN | MAX | NUMBER | PERCENT | PERCENTILE` (`NUMBER/PERCENT/PERCENTILE` need `value`).

## Data validation — dropdown from a fixed list

```json
[{"setDataValidation": {
  "range": {"sheetId": SHEET_ID, "startRowIndex": 1, "startColumnIndex": 3, "endColumnIndex": 4},
  "rule": {
    "condition": {"type": "ONE_OF_LIST", "values": [
      {"userEnteredValue": "New"}, {"userEnteredValue": "Active"}, {"userEnteredValue": "Done"}
    ]},
    "showCustomUi": true, "strict": true
  }
}}]
```
Dropdown from a range instead: `condition.type` = `ONE_OF_RANGE`,
`values:[{"userEnteredValue":"='Lists'!A2:A20"}]`.

## Protected range (warning-only or restricted)

```json
[{"addProtectedRange": {"protectedRange": {
  "range": {"sheetId": SHEET_ID, "startRowIndex": 0, "endRowIndex": 1},
  "description": "Header — do not edit",
  "warningOnly": true
}}}]
```
For hard protection drop `warningOnly` and add `"editors": {"users": ["a@example.com"]}`.

## Named range

```json
[{"addNamedRange": {"namedRange": {
  "name": "SalesData",
  "range": {"sheetId": SHEET_ID, "startRowIndex": 0, "endRowIndex": 100, "startColumnIndex": 0, "endColumnIndex": 4}
}}]
```

## Basic chart (column) anchored on the sheet

Domain = the category/label column; series = the numeric column(s). `sourceRange.sources` are
GridRanges. `newSheet:false` + `overlayPosition.anchorCell` drops it on the current sheet.

```json
[{"addChart": {"chart": {
  "spec": {
    "title": "Sales by month",
    "basicChart": {
      "chartType": "COLUMN",
      "legendPosition": "BOTTOM_LEGEND",
      "axis": [
        {"position": "BOTTOM_AXIS", "title": "Month"},
        {"position": "LEFT_AXIS", "title": "Kč"}
      ],
      "domains": [{"domain": {"sourceRange": {"sources": [
        {"sheetId": SHEET_ID, "startRowIndex": 0, "endRowIndex": 13, "startColumnIndex": 0, "endColumnIndex": 1}
      ]}}}],
      "series": [{"series": {"sourceRange": {"sources": [
        {"sheetId": SHEET_ID, "startRowIndex": 0, "endRowIndex": 13, "startColumnIndex": 1, "endColumnIndex": 2}
      ]}}, "targetAxis": "LEFT_AXIS"}],
      "headerCount": 1
    }
  },
  "position": {"overlayPosition": {"anchorCell": {"sheetId": SHEET_ID, "rowIndex": 1, "columnIndex": 6}}}
}}}]
```
For a line chart set `"chartType": "LINE"`.

## Pivot table (write into a cell of another sheet)

A pivot lives inside a cell via `updateCells` — put it at the top-left of an empty target sheet.

```json
[{"updateCells": {
  "start": {"sheetId": TARGET_SHEET_ID, "rowIndex": 0, "columnIndex": 0},
  "fields": "pivotTable",
  "rows": [{"values": [{"pivotTable": {
    "source": {"sheetId": SOURCE_SHEET_ID, "startRowIndex": 0, "endRowIndex": 100, "startColumnIndex": 0, "endColumnIndex": 4},
    "rows": [{"sourceColumnOffset": 0, "showTotals": true, "sortOrder": "ASCENDING"}],
    "values": [{"summarizeFunction": "SUM", "sourceColumnOffset": 3}],
    "valueLayout": "HORIZONTAL"
  }}]}]
}}]
```
`sourceColumnOffset` is 0-based **relative to the source range's first column**.

## Merge cells

```json
[{"mergeCells": {"mergeType": "MERGE_ALL",
  "range": {"sheetId": SHEET_ID, "startRowIndex": 0, "endRowIndex": 1, "startColumnIndex": 0, "endColumnIndex": 4}}}]
```
`mergeType`: `MERGE_ALL | MERGE_COLUMNS | MERGE_ROWS`. Unmerge with `{"unmergeCells": {"range": …}}`.

## Hide gridlines

```json
[{"updateSheetProperties": {
  "properties": {"sheetId": SHEET_ID, "gridProperties": {"hideGridlines": true}},
  "fields": "gridProperties.hideGridlines"
}}]
```

## Insert / delete rows or columns

```json
[
  {"insertDimension": {"range": {"sheetId": SHEET_ID, "dimension": "ROWS", "startIndex": 1, "endIndex": 3}, "inheritFromBefore": true}},
  {"deleteDimension": {"range": {"sheetId": SHEET_ID, "dimension": "COLUMNS", "startIndex": 5, "endIndex": 6}}}
]
```
`insertDimension` adds `endIndex-startIndex` lines before `endIndex`; `deleteDimension` removes the
half-open span. Use `dimension:"COLUMNS"` for columns.

## Sort a range (by column B ascending)

```json
[{"sortRange": {
  "range": {"sheetId": SHEET_ID, "startRowIndex": 1, "startColumnIndex": 0, "endColumnIndex": 4},
  "sortSpecs": [{"dimensionIndex": 1, "sortOrder": "ASCENDING"}]
}}]
```
`dimensionIndex` is absolute (0 = column A). Exclude the header by starting at row index 1.

## Borders around a block

```json
[{"updateBorders": {
  "range": {"sheetId": SHEET_ID, "startRowIndex": 0, "endRowIndex": 10, "startColumnIndex": 0, "endColumnIndex": 4},
  "top": {"style": "SOLID"}, "bottom": {"style": "SOLID"},
  "left": {"style": "SOLID"}, "right": {"style": "SOLID"},
  "innerHorizontal": {"style": "SOLID"}, "innerVertical": {"style": "SOLID"}
}}]
```
`style`: `SOLID | SOLID_MEDIUM | SOLID_THICK | DOTTED | DASHED | DOUBLE`. Add
`"color": {"red":…}` per side if you want non-black lines.
