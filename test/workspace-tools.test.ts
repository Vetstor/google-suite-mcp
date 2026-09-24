import { describe, it, expect } from "vitest";
import type { docs_v1, slides_v1 } from "googleapis";
import { extractDocText, extractTabs } from "../src/tools/docs.js";
import {
  buildPlaceholderInserts,
  summarizeSlides,
} from "../src/tools/slides.js";

// ---------------------------------------------------------------------------
// Docs plain-text extraction
// ---------------------------------------------------------------------------

describe("extractDocText", () => {
  const body: docs_v1.Schema$StructuralElement[] = [
    {
      paragraph: {
        elements: [{ textRun: { content: "Title Here\n" } }],
        paragraphStyle: { namedStyleType: "HEADING_1" },
      },
    },
    {
      paragraph: {
        elements: [{ textRun: { content: "Some body text.\n" } }],
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      },
    },
    {
      paragraph: {
        elements: [{ textRun: { content: "Sub heading\n" } }],
        paragraphStyle: { namedStyleType: "HEADING_3" },
      },
    },
    {
      paragraph: {
        elements: [{ textRun: { content: "First bullet\n" } }],
        bullet: { listId: "list-1" },
      },
    },
    {
      table: {
        tableRows: [
          {
            tableCells: [
              {
                content: [
                  { paragraph: { elements: [{ textRun: { content: "A1\n" } }] } },
                ],
              },
              {
                content: [
                  { paragraph: { elements: [{ textRun: { content: "B1\n" } }] } },
                ],
              },
            ],
          },
        ],
      },
    },
  ];

  it("prefixes headings, bullets, and joins table cells", () => {
    const text = extractDocText(body);
    expect(text).toBe(
      ["# Title Here", "Some body text.", "### Sub heading", "- First bullet", "A1 | B1"].join(
        "\n"
      )
    );
  });

  it("returns empty string for empty content", () => {
    expect(extractDocText([])).toBe("");
    expect(extractDocText(undefined)).toBe("");
  });

  it("extractTabs flattens tabs and child tabs with their text", () => {
    const tabs: docs_v1.Schema$Tab[] = [
      {
        tabProperties: { tabId: "t1", title: "Parent" },
        documentTab: {
          body: {
            content: [
              { paragraph: { elements: [{ textRun: { content: "parent text\n" } }] } },
            ],
          },
        },
        childTabs: [
          {
            tabProperties: { tabId: "t2", title: "Child" },
            documentTab: {
              body: {
                content: [
                  { paragraph: { elements: [{ textRun: { content: "child text\n" } }] } },
                ],
              },
            },
          },
        ],
      },
    ];
    const out = extractTabs(tabs);
    expect(out).toEqual([
      { tabId: "t1", title: "Parent", text: "parent text" },
      { tabId: "t2", title: "Child", text: "child text" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Slides placeholder-fill logic
// ---------------------------------------------------------------------------

describe("buildPlaceholderInserts", () => {
  const page: slides_v1.Schema$Page = {
    objectId: "slide1",
    pageElements: [
      {
        objectId: "title-id",
        shape: { shapeType: "TEXT_BOX", placeholder: { type: "TITLE" } },
      },
      {
        objectId: "body-id",
        shape: { shapeType: "TEXT_BOX", placeholder: { type: "BODY" } },
      },
    ],
  };

  it("targets the TITLE and BODY placeholders with insertText requests", () => {
    const { requests, filled } = buildPlaceholderInserts(page, {
      title: "Hello",
      body: "World",
    });
    expect(filled).toEqual({ title: "title-id", body: "body-id" });
    expect(requests).toEqual([
      { insertText: { objectId: "title-id", text: "Hello", insertionIndex: 0 } },
      { insertText: { objectId: "body-id", text: "World", insertionIndex: 0 } },
    ]);
  });

  it("only fills what is provided and present", () => {
    const { requests, filled } = buildPlaceholderInserts(page, { title: "Only title" });
    expect(filled).toEqual({ title: "title-id" });
    expect(requests).toHaveLength(1);
  });

  it("uses CENTERED_TITLE / SUBTITLE as title / body fallbacks", () => {
    const alt: slides_v1.Schema$Page = {
      objectId: "slide2",
      pageElements: [
        {
          objectId: "ct",
          shape: { placeholder: { type: "CENTERED_TITLE" } },
        },
        { objectId: "sub", shape: { placeholder: { type: "SUBTITLE" } } },
      ],
    };
    const { filled } = buildPlaceholderInserts(alt, { title: "T", body: "B" });
    expect(filled).toEqual({ title: "ct", body: "sub" });
  });

  it("returns no requests when the slide has no matching placeholders", () => {
    const blank: slides_v1.Schema$Page = {
      objectId: "s",
      pageElements: [{ objectId: "x", shape: { shapeType: "TEXT_BOX" } }],
    };
    const { requests, filled } = buildPlaceholderInserts(blank, { title: "x", body: "y" });
    expect(requests).toHaveLength(0);
    expect(filled).toEqual({});
  });
});

describe("summarizeSlides", () => {
  it("extracts objectId, index, layout, notes, and element text", () => {
    const slides: slides_v1.Schema$Page[] = [
      {
        objectId: "slide1",
        slideProperties: {
          layoutObjectId: "layout1",
          notesPage: {
            notesProperties: { speakerNotesObjectId: "notes1" },
            pageElements: [
              {
                objectId: "notes1",
                shape: {
                  text: { textElements: [{ textRun: { content: "Remember this\n" } }] },
                },
              },
            ],
          },
        },
        pageElements: [
          {
            objectId: "el1",
            shape: {
              placeholder: { type: "TITLE" },
              text: { textElements: [{ textRun: { content: "My Title" } }] },
            },
          },
        ],
      },
    ];
    const out = summarizeSlides(slides);
    expect(out).toEqual([
      {
        objectId: "slide1",
        index: 0,
        layout: "layout1",
        notes: "Remember this",
        elements: [
          {
            objectId: "el1",
            type: "shape",
            text: "My Title",
            placeholderType: "TITLE",
          },
        ],
      },
    ]);
  });
});
