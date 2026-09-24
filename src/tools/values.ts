import { z } from "zod";
import {
  parseSpreadsheetId,
  handleGoogleError,
  jsonResult,
  defineTool,
  type RegisterCtx,
} from "../helpers.js";

const ValueRenderOption = z
  .enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"])
  .default("FORMATTED_VALUE")
  .describe(
    "How values are rendered: FORMATTED_VALUE (default), UNFORMATTED_VALUE, or FORMULA."
  );

const MajorDimension = z
  .enum(["ROWS", "COLUMNS"])
  .default("ROWS")
  .describe("Return data by ROWS (default) or COLUMNS.");

const ValueInputOption = z
  .enum(["USER_ENTERED", "RAW"])
  .default("USER_ENTERED")
  .describe(
    "How input is interpreted: USER_ENTERED (parses formulas/dates, default) or RAW."
  );

function toObjects(values: unknown[][]): Array<Record<string, unknown>> {
  if (values.length === 0) return [];
  const headers = values[0].map(String);
  return values.slice(1).map((row) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? null;
    });
    return obj;
  });
}

export function registerValueTools(ctx: RegisterCtx) {
  defineTool(
    ctx,
    "read_range",
    {
      description:
        "Read cell values from a range. Use A1 notation, e.g. 'Sheet1!A1:D10' or just 'Sheet1'. Sheet names with spaces need single quotes: `'My Sheet'!A1:B5`. Set asObjects=true to treat the first row as headers and return an array of objects.",
      inputSchema: {
        spreadsheetId: z.string().describe("Spreadsheet ID or full URL."),
        range: z
          .string()
          .describe(
            "A1 notation range, e.g. 'Sheet1!A1:D10'. Omit column/row for whole sheet."
          ),
        valueRenderOption: ValueRenderOption.optional(),
        majorDimension: MajorDimension.optional(),
        asObjects: z
          .boolean()
          .default(false)
          .describe(
            "If true, treat first row as headers and return array of objects."
          ),
      },
    },
    async ({ spreadsheetId, range, valueRenderOption, majorDimension, asObjects }) => {
      try {
        const id = parseSpreadsheetId(spreadsheetId);
        const { sheets } = await ctx.getClients();
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: id,
          range,
          valueRenderOption: valueRenderOption ?? "FORMATTED_VALUE",
          majorDimension: majorDimension ?? "ROWS",
        });
        const values = (res.data.values as unknown[][] | undefined) ?? [];
        const data = asObjects ? toObjects(values) : values;
        return jsonResult({ range: res.data.range, values: data });
      } catch (err) {
        return handleGoogleError(err, "read_range");
      }
    }
  );

  defineTool(
    ctx,
    "batch_read",
    {
      description:
        "Read multiple ranges at once. Returns an array of range results. Use A1 notation for each range.",
      inputSchema: {
        spreadsheetId: z.string().describe("Spreadsheet ID or full URL."),
        ranges: z.array(z.string()).describe("Array of A1 notation ranges to read."),
        valueRenderOption: ValueRenderOption.optional(),
        majorDimension: MajorDimension.optional(),
      },
    },
    async ({ spreadsheetId, ranges, valueRenderOption, majorDimension }) => {
      try {
        const id = parseSpreadsheetId(spreadsheetId);
        const { sheets } = await ctx.getClients();
        const res = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: id,
          ranges,
          valueRenderOption: valueRenderOption ?? "FORMATTED_VALUE",
          majorDimension: majorDimension ?? "ROWS",
        });
        return jsonResult(res.data.valueRanges ?? []);
      } catch (err) {
        return handleGoogleError(err, "batch_read");
      }
    }
  );

  defineTool(
    ctx,
    "write_range",
    {
      description:
        "Write values to a range. values is a 2D array (rows × columns). Use A1 notation for range, e.g. 'Sheet1!A1'. Sheet names with spaces: `'My Sheet'!A1`.",
      inputSchema: {
        spreadsheetId: z.string().describe("Spreadsheet ID or full URL."),
        range: z.string().describe("A1 notation range to start writing at."),
        values: z
          .array(z.array(z.unknown()))
          .describe("2D array of values (rows of columns)."),
        valueInputOption: ValueInputOption.optional(),
      },
    },
    async ({ spreadsheetId, range, values, valueInputOption }) => {
      try {
        const id = parseSpreadsheetId(spreadsheetId);
        const { sheets } = await ctx.getClients();
        const res = await sheets.spreadsheets.values.update({
          spreadsheetId: id,
          range,
          valueInputOption: valueInputOption ?? "USER_ENTERED",
          requestBody: { values },
        });
        return jsonResult({
          updatedRange: res.data.updatedRange,
          updatedRows: res.data.updatedRows,
          updatedColumns: res.data.updatedColumns,
          updatedCells: res.data.updatedCells,
        });
      } catch (err) {
        return handleGoogleError(err, "write_range");
      }
    }
  );

  defineTool(
    ctx,
    "batch_write",
    {
      description:
        "Write values to multiple ranges in a single API call. Each item has a range (A1 notation) and a 2D values array.",
      inputSchema: {
        spreadsheetId: z.string().describe("Spreadsheet ID or full URL."),
        data: z
          .array(
            z.object({
              range: z.string().describe("A1 notation range."),
              values: z.array(z.array(z.unknown())).describe("2D array of values."),
            })
          )
          .describe("Array of {range, values} objects to write."),
        valueInputOption: ValueInputOption.optional(),
      },
    },
    async ({ spreadsheetId, data, valueInputOption }) => {
      try {
        const id = parseSpreadsheetId(spreadsheetId);
        const { sheets } = await ctx.getClients();
        const res = await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: id,
          requestBody: {
            valueInputOption: valueInputOption ?? "USER_ENTERED",
            data,
          },
        });
        return jsonResult(res.data.responses ?? []);
      } catch (err) {
        return handleGoogleError(err, "batch_write");
      }
    }
  );

  defineTool(
    ctx,
    "append_rows",
    {
      description:
        "Append rows to a sheet or table range. Finds the first empty row after existing data and writes there.",
      inputSchema: {
        spreadsheetId: z.string().describe("Spreadsheet ID or full URL."),
        range: z
          .string()
          .describe(
            "Sheet name or A1 range indicating the table, e.g. 'Sheet1' or 'Sheet1!A:D'."
          ),
        values: z.array(z.array(z.unknown())).describe("2D array of rows to append."),
        valueInputOption: ValueInputOption.optional(),
        insertDataOption: z
          .enum(["INSERT_ROWS", "OVERWRITE"])
          .default("INSERT_ROWS")
          .optional()
          .describe(
            "INSERT_ROWS (default): inserts new rows. OVERWRITE: writes over empty rows."
          ),
      },
    },
    async ({ spreadsheetId, range, values, valueInputOption, insertDataOption }) => {
      try {
        const id = parseSpreadsheetId(spreadsheetId);
        const { sheets } = await ctx.getClients();
        const res = await sheets.spreadsheets.values.append({
          spreadsheetId: id,
          range,
          valueInputOption: valueInputOption ?? "USER_ENTERED",
          insertDataOption: insertDataOption ?? "INSERT_ROWS",
          requestBody: { values },
        });
        return jsonResult({
          updatedRange: res.data.updates?.updatedRange,
          updatedRows: res.data.updates?.updatedRows,
          updatedCells: res.data.updates?.updatedCells,
        });
      } catch (err) {
        return handleGoogleError(err, "append_rows");
      }
    }
  );

  defineTool(
    ctx,
    "clear_range",
    {
      description:
        "Clear all values in a range (keeps formatting). Use A1 notation, e.g. 'Sheet1!A1:D10' or 'Sheet1'.",
      inputSchema: {
        spreadsheetId: z.string().describe("Spreadsheet ID or full URL."),
        range: z.string().describe("A1 notation range to clear."),
      },
    },
    async ({ spreadsheetId, range }) => {
      try {
        const id = parseSpreadsheetId(spreadsheetId);
        const { sheets } = await ctx.getClients();
        const res = await sheets.spreadsheets.values.clear({
          spreadsheetId: id,
          range,
        });
        return jsonResult({ clearedRange: res.data.clearedRange });
      } catch (err) {
        return handleGoogleError(err, "clear_range");
      }
    }
  );

  defineTool(
    ctx,
    "find_cells",
    {
      description:
        "Search for cells matching a query string within a sheet or range. Returns up to 200 matching cells with their address, row/col indices, and value.",
      inputSchema: {
        spreadsheetId: z.string().describe("Spreadsheet ID or full URL."),
        query: z.string().describe("Text to search for."),
        range: z
          .string()
          .optional()
          .describe(
            "A1 range to search within (default: entire first sheet). Example: 'Sheet1' or 'Sheet1!A:D'."
          ),
        matchCase: z
          .boolean()
          .default(false)
          .describe("Case-sensitive search (default false)."),
        exact: z
          .boolean()
          .default(false)
          .describe("Exact match (default false = substring match)."),
      },
    },
    async ({ spreadsheetId, query, range, matchCase, exact }) => {
      try {
        const id = parseSpreadsheetId(spreadsheetId);
        const { sheets } = await ctx.getClients();

        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: id,
          range: range ?? "Sheet1",
          valueRenderOption: "FORMATTED_VALUE",
          majorDimension: "ROWS",
        });

        const values = (res.data.values as string[][] | undefined) ?? [];
        const results: Array<{ cell: string; row: number; col: number; value: string }> = [];
        const searchQuery = matchCase ? query : query.toLowerCase();

        for (let r = 0; r < values.length; r++) {
          for (let c = 0; c < values[r].length; c++) {
            const cellVal = String(values[r][c] ?? "");
            const compareVal = matchCase ? cellVal : cellVal.toLowerCase();
            const matches = exact
              ? compareVal === searchQuery
              : compareVal.includes(searchQuery);

            if (matches) {
              const colLetter = colToLetter(c);
              results.push({ cell: `${colLetter}${r + 1}`, row: r + 1, col: c + 1, value: cellVal });
              if (results.length >= 200) break;
            }
          }
          if (results.length >= 200) break;
        }

        return jsonResult({ count: results.length, results });
      } catch (err) {
        return handleGoogleError(err, "find_cells");
      }
    }
  );
}

function colToLetter(col: number): string {
  let result = "";
  let n = col;
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}
