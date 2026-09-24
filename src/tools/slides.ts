import { z } from "zod";
import type { slides_v1 } from "googleapis";
import {
  parseDriveId,
  handleGoogleError,
  jsonResult,
  defineTool,
  type RegisterCtx,
} from "../helpers.js";

const EMU_PER_INCH = 914400;

function genId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 12)}`;
}

function shapeText(shape: slides_v1.Schema$Shape | undefined): string {
  let text = "";
  for (const te of shape?.text?.textElements ?? []) {
    if (te.textRun?.content) text += te.textRun.content;
  }
  return text;
}

function elementType(el: slides_v1.Schema$PageElement): string {
  if (el.shape) return "shape";
  if (el.image) return "image";
  if (el.table) return "table";
  if (el.line) return "line";
  if (el.video) return "video";
  if (el.wordArt) return "wordArt";
  if (el.sheetsChart) return "sheetsChart";
  if (el.elementGroup) return "group";
  return "unknown";
}

function notesText(slide: slides_v1.Schema$Page): string | undefined {
  const notesPage = slide.slideProperties?.notesPage;
  const speakerId = notesPage?.notesProperties?.speakerNotesObjectId;
  if (!notesPage || !speakerId) return undefined;
  const el = (notesPage.pageElements ?? []).find((e) => e.objectId === speakerId);
  const text = shapeText(el?.shape).trim();
  return text.length ? text : undefined;
}

interface SlideSummary {
  objectId?: string | null;
  index: number;
  layout?: string | null;
  notes?: string;
  elements: Array<{
    objectId?: string | null;
    type: string;
    text: string;
    placeholderType?: string | null;
  }>;
}

export function summarizeSlides(
  slides: slides_v1.Schema$Page[] | undefined
): SlideSummary[] {
  return (slides ?? []).map((slide, index) => ({
    objectId: slide.objectId,
    index,
    layout: slide.slideProperties?.layoutObjectId,
    notes: notesText(slide),
    elements: (slide.pageElements ?? []).map((el) => ({
      objectId: el.objectId,
      type: elementType(el),
      text: shapeText(el.shape),
      placeholderType: el.shape?.placeholder?.type,
    })),
  }));
}

const TITLE_TYPES = new Set(["TITLE", "CENTERED_TITLE"]);
const BODY_TYPES = new Set(["BODY", "SUBTITLE"]);

export interface PlaceholderInserts {
  requests: slides_v1.Schema$Request[];
  filled: { title?: string; body?: string };
}

export function buildPlaceholderInserts(
  page: slides_v1.Schema$Page,
  opts: { title?: string; body?: string }
): PlaceholderInserts {
  const requests: slides_v1.Schema$Request[] = [];
  const filled: { title?: string; body?: string } = {};
  const elements = page.pageElements ?? [];

  const findByTypes = (types: Set<string>) =>
    elements.find(
      (el) => el.shape?.placeholder?.type && types.has(el.shape.placeholder.type)
    );

  if (opts.title) {
    const el = findByTypes(TITLE_TYPES);
    if (el?.objectId) {
      filled.title = el.objectId;
      requests.push({
        insertText: { objectId: el.objectId, text: opts.title, insertionIndex: 0 },
      });
    }
  }
  if (opts.body) {
    const el = findByTypes(BODY_TYPES);
    if (el?.objectId) {
      filled.body = el.objectId;
      requests.push({
        insertText: { objectId: el.objectId, text: opts.body, insertionIndex: 0 },
      });
    }
  }
  return { requests, filled };
}

const PredefinedLayout = z
  .enum([
    "BLANK",
    "CAPTION_ONLY",
    "TITLE",
    "TITLE_AND_BODY",
    "TITLE_AND_TWO_COLUMNS",
    "TITLE_ONLY",
    "SECTION_HEADER",
    "SECTION_TITLE_AND_DESCRIPTION",
    "ONE_COLUMN_TEXT",
    "MAIN_POINT",
    "BIG_NUMBER",
  ])
  .describe("Predefined slide layout name.");

function elementProperties(
  pageObjectId: string,
  opts: {
    widthEmu?: number;
    heightEmu?: number;
    translateXEmu?: number;
    translateYEmu?: number;
  }
): slides_v1.Schema$PageElementProperties {
  return {
    pageObjectId,
    size: {
      width: { magnitude: opts.widthEmu ?? 4 * EMU_PER_INCH, unit: "EMU" },
      height: { magnitude: opts.heightEmu ?? 1 * EMU_PER_INCH, unit: "EMU" },
    },
    transform: {
      scaleX: 1,
      scaleY: 1,
      translateX: opts.translateXEmu ?? 1 * EMU_PER_INCH,
      translateY: opts.translateYEmu ?? 1 * EMU_PER_INCH,
      unit: "EMU",
    },
  };
}

const positionShape = {
  widthEmu: z
    .number()
    .optional()
    .describe("Width in EMU (1 inch = 914400 EMU). Default 4 in."),
  heightEmu: z
    .number()
    .optional()
    .describe("Height in EMU (1 inch = 914400 EMU). Default 1 in."),
  translateXEmu: z
    .number()
    .optional()
    .describe("X offset from top-left in EMU. Default 1 in."),
  translateYEmu: z
    .number()
    .optional()
    .describe("Y offset from top-left in EMU. Default 1 in."),
};

export function registerSlidesTools(ctx: RegisterCtx) {
  defineTool(
    ctx,
    "list_presentations",
    {
      description:
        "List Google Slides presentations accessible to the caller. Optionally filter by name (substring) or Drive folder.",
      inputSchema: {
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
    },
    async ({ query, folderId, pageSize }) => {
      try {
        const { drive } = await ctx.getClients();
        let q =
          "mimeType='application/vnd.google-apps.presentation' and trashed=false";
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
        return handleGoogleError(err, "list_presentations");
      }
    }
  );

  defineTool(
    ctx,
    "get_presentation",
    {
      description:
        "Get a presentation's structure: {presentationId, title, slides:[{objectId, index, layout, notes?, elements:[{objectId, type, text, placeholderType?}]}]}. Set includeRaw=true to also return the raw Slides API JSON (large).",
      inputSchema: {
        presentationId: z
          .string()
          .describe("Presentation ID or full Google Slides URL."),
        includeRaw: z
          .boolean()
          .default(false)
          .describe("Also return the raw presentation JSON (large). Default false."),
      },
    },
    async ({ presentationId, includeRaw }) => {
      try {
        const id = parseDriveId(presentationId);
        const { slides } = await ctx.getClients();
        const res = await slides.presentations.get({ presentationId: id });
        const out: Record<string, unknown> = {
          presentationId: res.data.presentationId,
          title: res.data.title,
          slides: summarizeSlides(res.data.slides),
        };
        if (includeRaw) out.raw = res.data;
        return jsonResult(out);
      } catch (err) {
        return handleGoogleError(err, "get_presentation");
      }
    }
  );

  defineTool(
    ctx,
    "create_presentation",
    {
      description:
        "Create a new Google Slides presentation. Optionally place it in a Drive folder. Returns {presentationId, url, title}.",
      inputSchema: {
        title: z.string().describe("Title of the new presentation."),
        folderId: z
          .string()
          .optional()
          .describe("Drive folder ID to place the file in."),
      },
    },
    async ({ title, folderId }) => {
      try {
        const { slides, drive } = await ctx.getClients();
        const created = await slides.presentations.create({
          requestBody: { title },
        });
        const id = created.data.presentationId!;
        if (folderId) {
          await drive.files.update({
            fileId: id,
            addParents: folderId,
            removeParents: "root",
            fields: "id,parents",
          });
        }
        return jsonResult({
          presentationId: id,
          url: `https://docs.google.com/presentation/d/${id}/edit`,
          title: created.data.title,
        });
      } catch (err) {
        return handleGoogleError(err, "create_presentation");
      }
    }
  );

  defineTool(
    ctx,
    "add_slide",
    {
      description:
        "Add a slide with a predefined layout. Optionally fill its title and body placeholders. Returns the new slide objectId plus the placeholder ids that were filled.",
      inputSchema: {
        presentationId: z.string().describe("Presentation ID or full URL."),
        layout: PredefinedLayout,
        insertionIndex: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based index to insert at (default: append at end)."),
        title: z
          .string()
          .optional()
          .describe(
            "Text for the slide's title placeholder, if the layout has one."
          ),
        body: z
          .string()
          .optional()
          .describe(
            "Text for the slide's body placeholder, if the layout has one."
          ),
      },
    },
    async ({ presentationId, layout, insertionIndex, title, body }) => {
      try {
        const id = parseDriveId(presentationId);
        const { slides } = await ctx.getClients();
        const slideId = genId("slide_");

        const createReq: slides_v1.Schema$Request = {
          createSlide: {
            objectId: slideId,
            slideLayoutReference: { predefinedLayout: layout },
          },
        };
        if (insertionIndex !== undefined) {
          createReq.createSlide!.insertionIndex = insertionIndex;
        }
        await slides.presentations.batchUpdate({
          presentationId: id,
          requestBody: { requests: [createReq] },
        });

        let filled: PlaceholderInserts["filled"] = {};
        if (title || body) {
          const page = await slides.presentations.pages.get({
            presentationId: id,
            pageObjectId: slideId,
          });
          const inserts = buildPlaceholderInserts(page.data, { title, body });
          filled = inserts.filled;
          if (inserts.requests.length > 0) {
            await slides.presentations.batchUpdate({
              presentationId: id,
              requestBody: { requests: inserts.requests },
            });
          }
        }
        return jsonResult({ slideObjectId: slideId, placeholders: filled });
      } catch (err) {
        return handleGoogleError(err, "add_slide");
      }
    }
  );

  defineTool(
    ctx,
    "replace_text_in_presentation",
    {
      description:
        "Replace all occurrences of a string across a presentation (or specific slides). Returns occurrencesChanged.",
      inputSchema: {
        presentationId: z.string().describe("Presentation ID or full URL."),
        find: z.string().describe("Exact text to find."),
        replace: z.string().describe("Replacement text."),
        matchCase: z
          .boolean()
          .default(true)
          .describe("Case-sensitive match (default true)."),
        pageObjectIds: z
          .array(z.string())
          .optional()
          .describe("Restrict replacement to these slide object ids."),
      },
    },
    async ({ presentationId, find, replace, matchCase, pageObjectIds }) => {
      try {
        const id = parseDriveId(presentationId);
        const { slides } = await ctx.getClients();
        const res = await slides.presentations.batchUpdate({
          presentationId: id,
          requestBody: {
            requests: [
              {
                replaceAllText: {
                  containsText: { text: find, matchCase },
                  replaceText: replace,
                  pageObjectIds,
                },
              },
            ],
          },
        });
        const changed =
          res.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
        return jsonResult({ presentationId: id, occurrencesChanged: changed });
      } catch (err) {
        return handleGoogleError(err, "replace_text_in_presentation");
      }
    }
  );

  defineTool(
    ctx,
    "insert_text_box",
    {
      description:
        "Add a text box to a slide with the given text. Position/size are in EMU (1 inch = 914400 EMU); defaults to a 4x1 inch box at 1 inch,1 inch. Returns the new shape objectId.",
      inputSchema: {
        presentationId: z.string().describe("Presentation ID or full URL."),
        slideObjectId: z.string().describe("Object id of the slide to add to."),
        text: z.string().describe("Text to place in the box."),
        ...positionShape,
      },
    },
    async ({ presentationId, slideObjectId, text, ...pos }) => {
      try {
        const id = parseDriveId(presentationId);
        const { slides } = await ctx.getClients();
        const shapeId = genId("tb_");
        await slides.presentations.batchUpdate({
          presentationId: id,
          requestBody: {
            requests: [
              {
                createShape: {
                  objectId: shapeId,
                  shapeType: "TEXT_BOX",
                  elementProperties: elementProperties(slideObjectId, pos),
                },
              },
              { insertText: { objectId: shapeId, text, insertionIndex: 0 } },
            ],
          },
        });
        return jsonResult({ shapeObjectId: shapeId });
      } catch (err) {
        return handleGoogleError(err, "insert_text_box");
      }
    }
  );

  defineTool(
    ctx,
    "insert_image",
    {
      description:
        "Insert an image onto a slide from a public image URL. Position/size are in EMU (1 inch = 914400 EMU); defaults to a 4x1 inch box at 1 inch,1 inch. The URL must be publicly accessible. Returns the new image objectId.",
      inputSchema: {
        presentationId: z.string().describe("Presentation ID or full URL."),
        slideObjectId: z.string().describe("Object id of the slide to add to."),
        imageUrl: z
          .string()
          .url()
          .describe("Publicly accessible image URL (PNG/JPEG/GIF)."),
        ...positionShape,
      },
    },
    async ({ presentationId, slideObjectId, imageUrl, ...pos }) => {
      try {
        const id = parseDriveId(presentationId);
        const { slides } = await ctx.getClients();
        const imageId = genId("img_");
        await slides.presentations.batchUpdate({
          presentationId: id,
          requestBody: {
            requests: [
              {
                createImage: {
                  objectId: imageId,
                  url: imageUrl,
                  elementProperties: elementProperties(slideObjectId, pos),
                },
              },
            ],
          },
        });
        return jsonResult({ imageObjectId: imageId });
      } catch (err) {
        return handleGoogleError(err, "insert_image");
      }
    }
  );

  defineTool(
    ctx,
    "delete_slide",
    {
      description: "Delete a slide (or any page object) by its object id.",
      inputSchema: {
        presentationId: z.string().describe("Presentation ID or full URL."),
        objectId: z
          .string()
          .describe("Object id of the slide/object to delete."),
      },
    },
    async ({ presentationId, objectId }) => {
      try {
        const id = parseDriveId(presentationId);
        const { slides } = await ctx.getClients();
        await slides.presentations.batchUpdate({
          presentationId: id,
          requestBody: { requests: [{ deleteObject: { objectId } }] },
        });
        return jsonResult({ deleted: true, objectId });
      } catch (err) {
        return handleGoogleError(err, "delete_slide");
      }
    }
  );

  defineTool(
    ctx,
    "get_slide_thumbnail",
    {
      description:
        "Get a PNG thumbnail URL for a slide. The returned contentUrl is temporary (expires ~30 min).",
      inputSchema: {
        presentationId: z.string().describe("Presentation ID or full URL."),
        slideObjectId: z.string().describe("Object id of the slide to render."),
      },
    },
    async ({ presentationId, slideObjectId }) => {
      try {
        const id = parseDriveId(presentationId);
        const { slides } = await ctx.getClients();
        const res = await slides.presentations.pages.getThumbnail({
          presentationId: id,
          pageObjectId: slideObjectId,
        });
        return jsonResult({
          contentUrl: res.data.contentUrl,
          width: res.data.width,
          height: res.data.height,
        });
      } catch (err) {
        return handleGoogleError(err, "get_slide_thumbnail");
      }
    }
  );

  defineTool(
    ctx,
    "batch_update_slides_raw",
    {
      description:
        "Advanced escape hatch: send raw Slides API Request objects to presentations.batchUpdate. Use for layout, styling, tables, shapes, and anything not covered by other tools. See https://developers.google.com/slides/api/reference/rest/v1/presentations/request",
      inputSchema: {
        presentationId: z.string().describe("Presentation ID or full URL."),
        requests: z
          .array(z.record(z.string(), z.unknown()))
          .describe(
            "Array of Slides API Request objects, e.g. [{createSlide:{...}}, {insertText:{...}}]."
          ),
      },
    },
    async ({ presentationId, requests }) => {
      try {
        const id = parseDriveId(presentationId);
        const { slides } = await ctx.getClients();
        const res = await slides.presentations.batchUpdate({
          presentationId: id,
          requestBody: { requests: requests as slides_v1.Schema$Request[] },
        });
        return jsonResult(res.data.replies ?? []);
      } catch (err) {
        return handleGoogleError(err, "batch_update_slides_raw");
      }
    }
  );
}
