import { z } from "zod";
import {
  parseSpreadsheetId,
  handleGoogleError,
  jsonResult,
  defineTool,
  type RegisterCtx,
} from "../helpers.js";

export function registerAdvancedTools(ctx: RegisterCtx) {
  defineTool(
    ctx,
    "batch_update_raw",
    {
      description:
        "Advanced: send raw Sheets API Request objects to spreadsheets.batchUpdate. Use for formatting, merges, conditional formats, data validation, protected ranges, and anything not covered by other tools. See https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request for request types.",
      inputSchema: {
        spreadsheetId: z.string().describe("Spreadsheet ID or full URL."),
        requests: z
          .array(z.record(z.string(), z.unknown()))
          .describe(
            "Array of Sheets API Request objects, e.g. [{updateCells: {...}}, {mergeCells: {...}}]."
          ),
      },
    },
    async ({ spreadsheetId, requests }) => {
      try {
        const id = parseSpreadsheetId(spreadsheetId);
        const { sheets } = await ctx.getClients();
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: id,
          requestBody: { requests },
        });
        return jsonResult(res.data.replies ?? []);
      } catch (err) {
        return handleGoogleError(err, "batch_update_raw");
      }
    }
  );
}
