import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { forms_v1 } from "googleapis";
import {
  parseDriveId,
  handleGoogleError,
  jsonResult,
  type GetClients,
} from "../helpers.js";

// ---------------------------------------------------------------------------
// Item summarization (exported for unit testing)
// ---------------------------------------------------------------------------

/** Map a Forms API ChoiceQuestion.type to the compact suffix we surface. */
function choiceKind(type: string | null | undefined): string {
  switch (type) {
    case "RADIO":
      return "radio";
    case "CHECKBOX":
      return "checkbox";
    case "DROP_DOWN":
      return "dropdown";
    default:
      return (type ?? "unknown").toLowerCase();
  }
}

/**
 * Derive the compact question-kind label for a form item:
 * TEXT / PARAGRAPH / CHOICE(radio|checkbox|dropdown) / SCALE / DATE / TIME /
 * FILE_UPLOAD / GRID / PAGE_BREAK / TEXT_ITEM / IMAGE / VIDEO.
 */
export function itemType(item: forms_v1.Schema$Item): string {
  if (item.questionItem?.question) {
    const q = item.questionItem.question;
    if (q.textQuestion) return q.textQuestion.paragraph ? "PARAGRAPH" : "TEXT";
    if (q.choiceQuestion) return `CHOICE(${choiceKind(q.choiceQuestion.type)})`;
    if (q.scaleQuestion) return "SCALE";
    if (q.dateQuestion) return "DATE";
    if (q.timeQuestion) return "TIME";
    if (q.fileUploadQuestion) return "FILE_UPLOAD";
    return "QUESTION";
  }
  if (item.questionGroupItem) return "GRID";
  if (item.pageBreakItem) return "PAGE_BREAK";
  if (item.textItem) return "TEXT_ITEM";
  if (item.imageItem) return "IMAGE";
  if (item.videoItem) return "VIDEO";
  return "unknown";
}

interface ItemSummary {
  itemId?: string | null;
  index: number;
  title?: string | null;
  type: string;
  required: boolean;
  options?: string[];
}

/** Build the compact per-item summary returned by get_form. */
export function summarizeItems(
  items: forms_v1.Schema$Item[] | undefined
): ItemSummary[] {
  return (items ?? []).map((item, index) => {
    const q = item.questionItem?.question;
    const out: ItemSummary = {
      itemId: item.itemId,
      index,
      title: item.title,
      type: itemType(item),
      required: q?.required ?? false,
    };
    const options = q?.choiceQuestion?.options
      ?.map((o) => o.value ?? "")
      .filter((v) => v.length > 0);
    if (options && options.length > 0) out.options = options;
    return out;
  });
}

/**
 * Map questionId -> item title across a form's items so responses can be keyed
 * by the human-readable question title. Exported for unit testing.
 */
export function questionTitleMap(
  items: forms_v1.Schema$Item[] | undefined
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const item of items ?? []) {
    const qid = item.questionItem?.question?.questionId;
    if (qid) map[qid] = item.title ?? qid;
    // Question groups: each row question has its own id.
    for (const q of item.questionGroupItem?.questions ?? []) {
      if (q.questionId) map[q.questionId] = item.title ?? q.questionId;
    }
  }
  return map;
}

interface FlatResponse {
  responseId?: string | null;
  createTime?: string | null;
  respondentEmail?: string;
  answers: Record<string, string | string[]>;
}

/**
 * Flatten Forms API FormResponse objects into rows keyed by question title.
 * Single-value answers become a string; multi-value (CHECKBOX) become an array.
 * Exported for unit testing.
 */
export function flattenResponses(
  responses: forms_v1.Schema$FormResponse[] | undefined,
  titleById: Record<string, string>
): FlatResponse[] {
  return (responses ?? []).map((resp) => {
    const answers: Record<string, string | string[]> = {};
    for (const [qid, answer] of Object.entries(resp.answers ?? {})) {
      const key = titleById[qid] ?? qid;
      const values = (answer.textAnswers?.answers ?? [])
        .map((a) => a.value ?? "")
        .filter((v) => v.length > 0);
      answers[key] = values.length === 1 ? values[0] : values;
    }
    const out: FlatResponse = {
      responseId: resp.responseId,
      createTime: resp.createTime,
      answers,
    };
    if (resp.respondentEmail) out.respondentEmail = resp.respondentEmail;
    return out;
  });
}

// ---------------------------------------------------------------------------
// add_question request builder (exported for unit testing)
// ---------------------------------------------------------------------------

const AddQuestionType = z.enum([
  "SHORT_TEXT",
  "PARAGRAPH",
  "MULTIPLE_CHOICE",
  "CHECKBOXES",
  "DROPDOWN",
  "LINEAR_SCALE",
  "DATE",
  "TIME",
]);
type AddQuestionType = z.infer<typeof AddQuestionType>;

const ScaleSpec = z.object({
  low: z.number().int().describe("Lowest value of the scale (e.g. 1)."),
  high: z.number().int().describe("Highest value of the scale (e.g. 5)."),
  lowLabel: z.string().optional().describe("Label for the low end."),
  highLabel: z.string().optional().describe("Label for the high end."),
});

export interface AddQuestionOpts {
  title: string;
  type: AddQuestionType;
  index: number;
  required?: boolean;
  description?: string;
  options?: string[];
  scale?: z.infer<typeof ScaleSpec>;
}

/**
 * Build a Forms API createItem Request for a high-level add_question call.
 * Throws if required inputs for the chosen type are missing.
 */
export function buildAddQuestionRequest(
  opts: AddQuestionOpts
): forms_v1.Schema$Request {
  const question: forms_v1.Schema$Question = {
    required: opts.required ?? false,
  };

  switch (opts.type) {
    case "SHORT_TEXT":
      question.textQuestion = { paragraph: false };
      break;
    case "PARAGRAPH":
      question.textQuestion = { paragraph: true };
      break;
    case "MULTIPLE_CHOICE":
    case "CHECKBOXES":
    case "DROPDOWN": {
      if (!opts.options || opts.options.length === 0) {
        throw new Error(`${opts.type} requires a non-empty options[] array.`);
      }
      const choiceType =
        opts.type === "MULTIPLE_CHOICE"
          ? "RADIO"
          : opts.type === "CHECKBOXES"
            ? "CHECKBOX"
            : "DROP_DOWN";
      question.choiceQuestion = {
        type: choiceType,
        options: opts.options.map((value) => ({ value })),
      };
      break;
    }
    case "LINEAR_SCALE": {
      if (!opts.scale) {
        throw new Error("LINEAR_SCALE requires a scale {low, high} object.");
      }
      question.scaleQuestion = {
        low: opts.scale.low,
        high: opts.scale.high,
        lowLabel: opts.scale.lowLabel,
        highLabel: opts.scale.highLabel,
      };
      break;
    }
    case "DATE":
      question.dateQuestion = { includeYear: true };
      break;
    case "TIME":
      question.timeQuestion = { duration: false };
      break;
  }

  const item: forms_v1.Schema$Item = {
    title: opts.title,
    questionItem: { question },
  };
  if (opts.description) item.description = opts.description;

  return { createItem: { item, location: { index: opts.index } } };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerFormsTools(server: McpServer, getClients: GetClients) {
  server.tool(
    "list_forms",
    "List Google Forms accessible to the caller. Optionally filter by name (substring) or Drive folder.",
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
        let q = "mimeType='application/vnd.google-apps.form' and trashed=false";
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
        return handleGoogleError(err, "list_forms");
      }
    }
  );

  server.tool(
    "get_form",
    "Get a Google Form's structure: {formId, title, description, responderUri, linkedSheetId?, items:[{itemId, index, title, type, required, options?}]}. The type is the question kind: TEXT/PARAGRAPH/CHOICE(radio|checkbox|dropdown)/SCALE/DATE/TIME/FILE_UPLOAD/GRID/PAGE_BREAK/TEXT_ITEM/IMAGE/VIDEO. Set includeRaw=true to also return the raw Forms API JSON (large).",
    {
      formId: z.string().describe("Form ID or full Google Forms URL."),
      includeRaw: z
        .boolean()
        .default(false)
        .describe("Also return the raw form JSON (large). Default false."),
    },
    async ({ formId, includeRaw }) => {
      try {
        const id = parseDriveId(formId);
        const { forms } = await getClients();
        const res = await forms.forms.get({ formId: id });
        const form = res.data;
        const out: Record<string, unknown> = {
          formId: form.formId,
          title: form.info?.title,
          description: form.info?.description,
          responderUri: form.responderUri,
          items: summarizeItems(form.items),
        };
        if (form.linkedSheetId) out.linkedSheetId = form.linkedSheetId;
        if (includeRaw) out.raw = form;
        return jsonResult(out);
      } catch (err) {
        return handleGoogleError(err, "get_form");
      }
    }
  );

  server.tool(
    "create_form",
    "Create a new Google Form. The Forms API create call only accepts a title (and documentTitle); a description is applied via a follow-up batchUpdate. Optionally move it to a Drive folder. Returns {formId, responderUri, editUrl}.",
    {
      title: z.string().describe("Form title, visible to responders."),
      documentTitle: z
        .string()
        .optional()
        .describe("Drive file name (defaults to title if omitted)."),
      description: z
        .string()
        .optional()
        .describe("Form description (applied via batchUpdate after create)."),
      folderId: z
        .string()
        .optional()
        .describe("Drive folder ID to move the new form into."),
    },
    async ({ title, documentTitle, description, folderId }) => {
      try {
        const { forms, drive } = await getClients();
        const created = await forms.forms.create({
          requestBody: {
            info: { title, documentTitle: documentTitle ?? title },
          },
        });
        const id = created.data.formId!;

        if (description) {
          await forms.forms.batchUpdate({
            formId: id,
            requestBody: {
              requests: [
                {
                  updateFormInfo: {
                    info: { description },
                    updateMask: "description",
                  },
                },
              ],
            },
          });
        }
        if (folderId) {
          await drive.files.update({
            fileId: id,
            addParents: folderId,
            removeParents: "root",
            fields: "id,parents",
          });
        }
        return jsonResult({
          formId: id,
          responderUri: created.data.responderUri,
          editUrl: `https://docs.google.com/forms/d/${id}/edit`,
        });
      } catch (err) {
        return handleGoogleError(err, "create_form");
      }
    }
  );

  server.tool(
    "add_question",
    "Add a question to a Google Form. High-level wrapper over createItem. Choose a type; provide options[] for choice types (MULTIPLE_CHOICE/CHECKBOXES/DROPDOWN) and scale{low,high,lowLabel?,highLabel?} for LINEAR_SCALE. By default the question is appended at the end. Returns {itemId, index}.",
    {
      formId: z.string().describe("Form ID or full URL."),
      title: z.string().describe("The question text."),
      type: AddQuestionType.describe(
        "Question type: SHORT_TEXT, PARAGRAPH, MULTIPLE_CHOICE, CHECKBOXES, DROPDOWN, LINEAR_SCALE, DATE, TIME."
      ),
      required: z
        .boolean()
        .default(false)
        .describe("Whether an answer is required (default false)."),
      options: z
        .array(z.string())
        .optional()
        .describe("Choices for MULTIPLE_CHOICE/CHECKBOXES/DROPDOWN."),
      scale: ScaleSpec.optional().describe("Scale spec for LINEAR_SCALE."),
      description: z
        .string()
        .optional()
        .describe("Optional help text under the question."),
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("0-based position to insert at (default: append at end)."),
    },
    async ({ formId, title, type, required, options, scale, description, index }) => {
      try {
        const id = parseDriveId(formId);
        const { forms } = await getClients();

        let insertIndex = index;
        if (insertIndex === undefined) {
          const cur = await forms.forms.get({ formId: id });
          insertIndex = (cur.data.items ?? []).length;
        }

        const request = buildAddQuestionRequest({
          title,
          type,
          index: insertIndex,
          required,
          description,
          options,
          scale,
        });

        const res = await forms.forms.batchUpdate({
          formId: id,
          requestBody: { requests: [request] },
        });
        const itemId =
          res.data.replies?.[0]?.createItem?.itemId ?? undefined;
        return jsonResult({ itemId, index: insertIndex });
      } catch (err) {
        return handleGoogleError(err, "add_question");
      }
    }
  );

  server.tool(
    "update_form_info",
    "Update a Google Form's title and/or description. Returns {formId, updated}.",
    {
      formId: z.string().describe("Form ID or full URL."),
      title: z.string().optional().describe("New form title."),
      description: z.string().optional().describe("New form description."),
    },
    async ({ formId, title, description }) => {
      try {
        const id = parseDriveId(formId);
        const { forms } = await getClients();
        const info: forms_v1.Schema$Info = {};
        const masks: string[] = [];
        if (title !== undefined) {
          info.title = title;
          masks.push("title");
        }
        if (description !== undefined) {
          info.description = description;
          masks.push("description");
        }
        if (masks.length === 0) {
          throw new Error("Provide at least one of title or description.");
        }
        await forms.forms.batchUpdate({
          formId: id,
          requestBody: {
            requests: [
              { updateFormInfo: { info, updateMask: masks.join(",") } },
            ],
          },
        });
        return jsonResult({ formId: id, updated: masks });
      } catch (err) {
        return handleGoogleError(err, "update_form_info");
      }
    }
  );

  server.tool(
    "delete_item",
    "Delete an item (question, section, media) from a Google Form by its itemId. The item's current index is resolved via forms.get. Returns {formId, deletedItemId, index}.",
    {
      formId: z.string().describe("Form ID or full URL."),
      itemId: z.string().describe("The itemId to delete (from get_form)."),
    },
    async ({ formId, itemId }) => {
      try {
        const id = parseDriveId(formId);
        const { forms } = await getClients();
        const cur = await forms.forms.get({ formId: id });
        const index = (cur.data.items ?? []).findIndex(
          (it) => it.itemId === itemId
        );
        if (index < 0) {
          throw new Error(`Item ${itemId} not found in form ${id}.`);
        }
        await forms.forms.batchUpdate({
          formId: id,
          requestBody: {
            requests: [{ deleteItem: { location: { index } } }],
          },
        });
        return jsonResult({ formId: id, deletedItemId: itemId, index });
      } catch (err) {
        return handleGoogleError(err, "delete_item");
      }
    }
  );

  server.tool(
    "list_responses",
    "List responses to a Google Form, flattened to {responseId, createTime, respondentEmail?, answers:{[questionTitle]: value|value[]}}. Answers are keyed by question title (CHECKBOX answers become an array). Optional filter, e.g. 'timestamp > 2026-01-01T00:00:00Z'.",
    {
      formId: z.string().describe("Form ID or full URL."),
      filter: z
        .string()
        .optional()
        .describe(
          "Forms API responses filter, e.g. \"timestamp > 2026-01-01T00:00:00Z\"."
        ),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe("Max responses per page."),
      pageToken: z.string().optional().describe("Page token from a prior call."),
    },
    async ({ formId, filter, pageSize, pageToken }) => {
      try {
        const id = parseDriveId(formId);
        const { forms } = await getClients();
        // forms.get gives us the questionId -> title map for flattening.
        const [form, resp] = await Promise.all([
          forms.forms.get({ formId: id }),
          forms.forms.responses.list({
            formId: id,
            filter,
            pageSize,
            pageToken,
          }),
        ]);
        const titleById = questionTitleMap(form.data.items);
        return jsonResult({
          formId: id,
          responses: flattenResponses(resp.data.responses, titleById),
          nextPageToken: resp.data.nextPageToken ?? undefined,
        });
      } catch (err) {
        return handleGoogleError(err, "list_responses");
      }
    }
  );

  server.tool(
    "batch_update_forms_raw",
    "Advanced escape hatch: send raw Forms API Request objects to forms.batchUpdate. Use for anything not covered by other tools (moveItem, updateItem, media, sections, etc.). See https://developers.google.com/forms/api/reference/rest/v1/forms/batchUpdate",
    {
      formId: z.string().describe("Form ID or full URL."),
      requests: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
          "Array of Forms API Request objects, e.g. [{createItem:{...}}, {updateItem:{...}}]."
        ),
    },
    async ({ formId, requests }) => {
      try {
        const id = parseDriveId(formId);
        const { forms } = await getClients();
        const res = await forms.forms.batchUpdate({
          formId: id,
          requestBody: { requests: requests as forms_v1.Schema$Request[] },
        });
        return jsonResult(res.data.replies ?? []);
      } catch (err) {
        return handleGoogleError(err, "batch_update_forms_raw");
      }
    }
  );
}
