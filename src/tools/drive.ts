import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleGoogleError, jsonResult, type GetClients } from "../helpers.js";

export function registerDriveTools(server: McpServer, getClients: GetClients) {
  server.tool(
    "list_spreadsheets",
    "List Google Sheets accessible to the caller. Optionally filter by name (substring) or folder.",
    {
      query: z
        .string()
        .optional()
        .describe("Name substring to search for (case-insensitive)."),
      folderId: z
        .string()
        .optional()
        .describe("Restrict to a specific Drive folder ID."),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(50)
        .describe("Max results to return (default 50)."),
    },
    async ({ query, folderId, pageSize }) => {
      try {
        const { drive } = await getClients();

        let q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
        if (query) q += ` and name contains '${query.replace(/'/g, "\\'")}'`;
        if (folderId) q += ` and '${folderId}' in parents`;

        const res = await drive.files.list({
          q,
          pageSize,
          fields: "files(id,name,modifiedTime,webViewLink)",
          orderBy: "modifiedTime desc",
        });

        return jsonResult(res.data.files ?? []);
      } catch (err) {
        return handleGoogleError(err, "list_spreadsheets");
      }
    }
  );
}
