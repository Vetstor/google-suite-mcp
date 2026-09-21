import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  parseSpreadsheetId,
  handleGoogleError,
  jsonResult,
  type GetClients,
} from "../helpers.js";

export function registerMetadataTools(server: McpServer, getClients: GetClients) {
  server.tool(
    "get_spreadsheet",
    "Get spreadsheet metadata: title, list of sheets (sheetId, title, index, row/column counts), and named ranges. Does NOT return cell values.",
    {
      spreadsheetId: z
        .string()
        .describe("Spreadsheet ID or full Google Sheets URL."),
    },
    async ({ spreadsheetId }) => {
      try {
        const id = parseSpreadsheetId(spreadsheetId);
        const { sheets } = await getClients();
        const res = await sheets.spreadsheets.get({
          spreadsheetId: id,
          fields:
            "spreadsheetId,properties/title,sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount))),namedRanges",
        });
        return jsonResult(res.data);
      } catch (err) {
        return handleGoogleError(err, "get_spreadsheet");
      }
    }
  );

  server.tool(
    "create_spreadsheet",
    "Create a new Google Sheets spreadsheet. Optionally specify sheet tab titles and a Drive folder to place it in.",
    {
      title: z.string().describe("Title of the new spreadsheet."),
      sheetTitles: z
        .array(z.string())
        .optional()
        .describe(
          "List of sheet tab names to create (default: just 'Sheet1')."
        ),
      folderId: z
        .string()
        .optional()
        .describe("Drive folder ID to place the file in."),
    },
    async ({ title, sheetTitles, folderId }) => {
      try {
        const { sheets, drive } = await getClients();

        const sheetsBody =
          sheetTitles && sheetTitles.length > 0
            ? sheetTitles.map((t, i) => ({
                properties: { title: t, index: i },
              }))
            : undefined;

        const res = await sheets.spreadsheets.create({
          requestBody: {
            properties: { title },
            sheets: sheetsBody,
          },
        });

        const fileId = res.data.spreadsheetId!;

        if (folderId) {
          await drive.files.update({
            fileId,
            addParents: folderId,
            removeParents: "root",
            fields: "id,parents",
          });
        }

        return jsonResult({
          spreadsheetId: fileId,
          url: `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
          title: res.data.properties?.title,
        });
      } catch (err) {
        return handleGoogleError(err, "create_spreadsheet");
      }
    }
  );

  server.tool(
    "add_sheet",
    "Add a new sheet tab to an existing spreadsheet.",
    {
      spreadsheetId: z.string().describe("Spreadsheet ID or full URL."),
      title: z.string().describe("Title for the new sheet tab."),
      rowCount: z
        .number()
        .int()
        .optional()
        .describe("Initial number of rows (default: 1000)."),
      columnCount: z
        .number()
        .int()
        .optional()
        .describe("Initial number of columns (default: 26)."),
    },
    async ({ spreadsheetId, title, rowCount, columnCount }) => {
      try {
        const id = parseSpreadsheetId(spreadsheetId);
        const { sheets } = await getClients();
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId: id,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title,
                    gridProperties: {
                      rowCount: rowCount ?? 1000,
                      columnCount: columnCount ?? 26,
                    },
                  },
                },
              },
            ],
          },
        });
        const added = res.data.replies?.[0]?.addSheet?.properties;
        return jsonResult(added);
      } catch (err) {
        return handleGoogleError(err, "add_sheet");
      }
    }
  );

  server.tool(
    "delete_sheet",
    "Delete a sheet tab by sheetId (numeric) or by title.",
    {
      spreadsheetId: z.string().describe("Spreadsheet ID or full URL."),
      sheetId: z
        .number()
        .int()
        .optional()
        .describe("Numeric sheetId to delete."),
      sheetTitle: z
        .string()
        .optional()
        .describe("Sheet tab title to delete (used if sheetId not given)."),
    },
    async ({ spreadsheetId, sheetId, sheetTitle }) => {
      try {
        const id = parseSpreadsheetId(spreadsheetId);
        const { sheets } = await getClients();

        let targetId = sheetId;

        if (targetId === undefined) {
          if (!sheetTitle) throw new Error("Provide sheetId or sheetTitle.");
          const meta = await sheets.spreadsheets.get({
            spreadsheetId: id,
            fields: "sheets/properties(sheetId,title)",
          });
          const found = meta.data.sheets?.find(
            (s) => s.properties?.title === sheetTitle
          );
          if (found?.properties?.sheetId === undefined || found.properties.sheetId === null) {
            throw new Error(`Sheet "${sheetTitle}" not found.`);
          }
          targetId = found.properties.sheetId;
        }

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: id,
          requestBody: {
            requests: [{ deleteSheet: { sheetId: targetId } }],
          },
        });

        return jsonResult({ deleted: true, sheetId: targetId });
      } catch (err) {
        return handleGoogleError(err, "delete_sheet");
      }
    }
  );
}
