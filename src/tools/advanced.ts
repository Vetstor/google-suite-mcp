import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetClients } from "../helpers.js";
import { parseSpreadsheetId, handleGoogleError, jsonResult } from "../helpers.js";

export function registerAdvancedTools(server: McpServer, getClients: GetClients) {
  server.tool(
    "batch_update_raw",
    "Advanced: send raw Sheets API Request objects to spreadsheets.batchUpdate. Use for formatting, merges, conditional formats, data validation, protected ranges, and anything not covered by other tools. See https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request for request types.",
    {
      spreadsheetId: z
        .string()
        .describe("Spreadsheet ID or full URL."),
      requests: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
          "Array of Sheets API Request objects, e.g. [{updateCells: {...}}, {mergeCells: {...}}]."
        ),
    },
    async ({ spreadsheetId, requests }) => {
      try {
        const id = parseSpreadsheetId(spreadsheetId);
        const { sheets } = await getClients();
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
