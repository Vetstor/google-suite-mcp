import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { docs_v1 } from "googleapis";
import {
  parseDriveId,
  handleGoogleError,
  jsonResult,
  type GetClients,
} from "../helpers.js";

// ---------------------------------------------------------------------------
// Plain-text extraction (exported for unit testing)
// ---------------------------------------------------------------------------

function paragraphText(p: docs_v1.Schema$Paragraph): string {
  let text = "";
  for (const el of p.elements ?? []) {
    if (el.textRun?.content) text += el.textRun.content;
  }
  return text;
}

/**
 * Walk a Docs `body.content` array and emit plain text lines. Headings styled
 * HEADING_1..6 are prefixed with the matching number of `#`; bulleted
 * paragraphs are prefixed with `- `; table cells are joined with ` | ` per row.
 */
function walk(
  content: docs_v1.Schema$StructuralElement[] | undefined,
  lines: string[]
): void {
  for (const el of content ?? []) {
    if (el.paragraph) {
      const raw = paragraphText(el.paragraph).replace(/\n+$/, "");
      const style = el.paragraph.paragraphStyle?.namedStyleType ?? "";
      const m = /^HEADING_([1-6])$/.exec(style);
      let prefix = "";
      if (m) prefix = "#".repeat(Number(m[1])) + " ";
      else if (el.paragraph.bullet) prefix = "- ";
      lines.push(raw.length ? prefix + raw : "");
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells: string[] = [];
        for (const cell of row.tableCells ?? []) {
          const cellLines: string[] = [];
          walk(cell.content, cellLines);
          cells.push(cellLines.join(" ").trim());
        }
        lines.push(cells.join(" | "));
      }
    } else if (el.tableOfContents) {
      walk(el.tableOfContents.content, lines);
    }
  }
}

/** Extract the plain text of a Docs `body.content` (or tab body) array. */
export function extractDocText(
  content: docs_v1.Schema$StructuralElement[] | undefined
): string {
  const lines: string[] = [];
  walk(content, lines);
  return lines.join("\n");
}

interface TabText {
  tabId?: string;
  title?: string;
  text: string;
}

/** Flatten a document's tabs (including child tabs) into id/title/text triples. */
export function extractTabs(
  tabs: docs_v1.Schema$Tab[] | undefined
): TabText[] {
  const out: TabText[] = [];
  for (const tab of tabs ?? []) {
    out.push({
      tabId: tab.tabProperties?.tabId ?? undefined,
      title: tab.tabProperties?.title ?? undefined,
      text: extractDocText(tab.documentTab?.body?.content),
    });
    if (tab.childTabs?.length) out.push(...extractTabs(tab.childTabs));
  }
  return out;
}

/** Compute the insert index for the end of the body (last endIndex - 1). */
function endOfBodyIndex(doc: docs_v1.Schema$Document): number {
  const content = doc.body?.content ?? [];
  const last = content[content.length - 1];
  const end = last?.endIndex ?? 2;
  // The final structural element ends with the body's trailing newline; you
  // cannot insert after it, so target one before.
  return Math.max(1, end - 1);
}

const HeadingStyle = z
  .enum([
    "NORMAL_TEXT",
    "HEADING_1",
    "HEADING_2",
    "HEADING_3",
    "HEADING_4",
    "HEADING_5",
    "HEADING_6",
  ])
  .describe("Named paragraph style to apply to the inserted text.");

export function registerDocsTools(server: McpServer, getClients: GetClients) {
  server.tool(
    "list_documents",
    "List Google Docs accessible to the caller. Optionally filter by name (substring) or Drive folder.",
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
        let q = "mimeType='application/vnd.google-apps.document' and trashed=false";
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
        return handleGoogleError(err, "list_documents");
      }
    }
  );

  server.tool(
    "get_document",
    "Get a Google Doc as plain text. Returns {documentId, title, revisionId, text, tabs?}. Headings become markdown '#', bullets become '- ', table cells are joined with ' | '. Set includeRaw=true to also return the raw Docs API body JSON (large).",
    {
      documentId: z.string().describe("Document ID or full Google Docs URL."),
      includeRaw: z
        .boolean()
        .default(false)
        .describe(
          "Also return the raw body JSON (WARNING: can be very large). Default false."
        ),
    },
    async ({ documentId, includeRaw }) => {
      try {
        const id = parseDriveId(documentId);
        const { docs } = await getClients();
        const res = await docs.documents.get({
          documentId: id,
          includeTabsContent: true,
        });
        const doc = res.data;
        const tabs = extractTabs(doc.tabs ?? undefined);
        const out: Record<string, unknown> = {
          documentId: doc.documentId,
          title: doc.title,
          revisionId: doc.revisionId,
          text: extractDocText(doc.body?.content),
        };
        if (tabs.length > 0) out.tabs = tabs;
        if (includeRaw) out.raw = doc.body;
        return jsonResult(out);
      } catch (err) {
        return handleGoogleError(err, "get_document");
      }
    }
  );

  server.tool(
    "create_document",
    "Create a new Google Doc. Optionally place it in a Drive folder and seed it with initial text. Returns {documentId, url, title}.",
    {
      title: z.string().describe("Title of the new document."),
      folderId: z
        .string()
        .optional()
        .describe("Drive folder ID to place the file in."),
      text: z
        .string()
        .optional()
        .describe("Initial body text inserted at the start of the document."),
    },
    async ({ title, folderId, text }) => {
      try {
        const { docs, drive } = await getClients();
        const created = await docs.documents.create({ requestBody: { title } });
        const id = created.data.documentId!;

        if (folderId) {
          await drive.files.update({
            fileId: id,
            addParents: folderId,
            removeParents: "root",
            fields: "id,parents",
          });
        }
        if (text) {
          // index 1 = the very start of the body (index 0 is not writable).
          await docs.documents.batchUpdate({
            documentId: id,
            requestBody: {
              requests: [{ insertText: { location: { index: 1 }, text } }],
            },
          });
        }
        return jsonResult({
          documentId: id,
          url: `https://docs.google.com/document/d/${id}/edit`,
          title: created.data.title,
        });
      } catch (err) {
        return handleGoogleError(err, "create_document");
      }
    }
  );

  server.tool(
    "append_text",
    "Append text to the end of a Google Doc's body. Optionally apply a heading style (HEADING_1..6 or NORMAL_TEXT) to the appended paragraph(s). Returns the range written.",
    {
      documentId: z.string().describe("Document ID or full URL."),
      text: z.string().describe("Text to append. Include a leading '\\n' to start a new paragraph."),
      heading: HeadingStyle.optional(),
    },
    async ({ documentId, text, heading }) => {
      try {
        const id = parseDriveId(documentId);
        const { docs } = await getClients();
        const doc = await docs.documents.get({ documentId: id });
        const index = endOfBodyIndex(doc.data);

        const requests: docs_v1.Schema$Request[] = [
          { insertText: { location: { index }, text } },
        ];
        if (heading) {
          requests.push({
            updateParagraphStyle: {
              range: { startIndex: index, endIndex: index + text.length },
              paragraphStyle: { namedStyleType: heading },
              fields: "namedStyleType",
            },
          });
        }
        await docs.documents.batchUpdate({
          documentId: id,
          requestBody: { requests },
        });
        return jsonResult({
          documentId: id,
          insertedAt: index,
          endIndex: index + text.length,
        });
      } catch (err) {
        return handleGoogleError(err, "append_text");
      }
    }
  );

  server.tool(
    "insert_text",
    "Insert text at an explicit 1-based index in a Google Doc's body (index 1 = start of the document). Returns the range written.",
    {
      documentId: z.string().describe("Document ID or full URL."),
      index: z
        .number()
        .int()
        .min(1)
        .describe("1-based insertion index into the body (1 = start)."),
      text: z.string().describe("Text to insert."),
    },
    async ({ documentId, index, text }) => {
      try {
        const id = parseDriveId(documentId);
        const { docs } = await getClients();
        await docs.documents.batchUpdate({
          documentId: id,
          requestBody: {
            requests: [{ insertText: { location: { index }, text } }],
          },
        });
        return jsonResult({
          documentId: id,
          insertedAt: index,
          endIndex: index + text.length,
        });
      } catch (err) {
        return handleGoogleError(err, "insert_text");
      }
    }
  );

  server.tool(
    "replace_text",
    "Replace all occurrences of a string in a Google Doc. Returns occurrencesChanged.",
    {
      documentId: z.string().describe("Document ID or full URL."),
      find: z.string().describe("Exact text to find."),
      replace: z.string().describe("Replacement text."),
      matchCase: z
        .boolean()
        .default(true)
        .describe("Case-sensitive match (default true)."),
    },
    async ({ documentId, find, replace, matchCase }) => {
      try {
        const id = parseDriveId(documentId);
        const { docs } = await getClients();
        const res = await docs.documents.batchUpdate({
          documentId: id,
          requestBody: {
            requests: [
              {
                replaceAllText: {
                  containsText: { text: find, matchCase },
                  replaceText: replace,
                },
              },
            ],
          },
        });
        const changed =
          res.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
        return jsonResult({ documentId: id, occurrencesChanged: changed });
      } catch (err) {
        return handleGoogleError(err, "replace_text");
      }
    }
  );

  server.tool(
    "batch_update_docs_raw",
    "Advanced escape hatch: send raw Docs API Request objects to documents.batchUpdate. Use for styling, tables, named ranges, and anything not covered by other tools. Docs body indices are 1-based (index 1 = start of body). See https://developers.google.com/docs/api/reference/rest/v1/documents/request",
    {
      documentId: z.string().describe("Document ID or full URL."),
      requests: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
          "Array of Docs API Request objects, e.g. [{insertText:{...}}, {updateTextStyle:{...}}]."
        ),
    },
    async ({ documentId, requests }) => {
      try {
        const id = parseDriveId(documentId);
        const { docs } = await getClients();
        const res = await docs.documents.batchUpdate({
          documentId: id,
          requestBody: { requests: requests as docs_v1.Schema$Request[] },
        });
        return jsonResult(res.data.replies ?? []);
      } catch (err) {
        return handleGoogleError(err, "batch_update_docs_raw");
      }
    }
  );
}
