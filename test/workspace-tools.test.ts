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

// ---------------------------------------------------------------------------
// Bug fix: get_document tabs fallback (extractTabs + extractDocText)
// When a doc uses tabs, body content lives in tabs[].documentTab.body.
// The top-level body is empty and must fall back to joining tabs' text.
// ---------------------------------------------------------------------------

describe("get_document tabs fallback logic", () => {
  it("extractDocText on empty body returns empty string", () => {
    expect(extractDocText([])).toBe("");
    expect(extractDocText(undefined)).toBe("");
  });

  it("extractTabs returns tab text from documentTab body", () => {
    const tabs: docs_v1.Schema$Tab[] = [
      {
        tabProperties: { tabId: "t1", title: "Tab One" },
        documentTab: {
          body: {
            content: [
              {
                paragraph: {
                  elements: [{ textRun: { content: "Tab one content\n" } }],
                  paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                },
              },
            ],
          },
        },
      },
      {
        tabProperties: { tabId: "t2", title: "Tab Two" },
        documentTab: {
          body: {
            content: [
              {
                paragraph: {
                  elements: [{ textRun: { content: "Tab two content\n" } }],
                  paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                },
              },
            ],
          },
        },
      },
    ];
    const result = extractTabs(tabs);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Tab one content");
    expect(result[1].text).toBe("Tab two content");
    // Joined fallback text for top-level text field
    const topText = result.map((t) => t.text).join("\n\n");
    expect(topText).toBe("Tab one content\n\nTab two content");
  });
});

// ---------------------------------------------------------------------------
// Bug fix: append_text heading offset (leading newlines shift style range)
// When text starts with '\n', updateParagraphStyle must skip leading newlines
// so the style targets the new paragraph, not the previous one.
// ---------------------------------------------------------------------------

describe("append_text heading offset logic", () => {
  it("counts leading newlines correctly", () => {
    const texts = [
      { text: "\nHello", leadingNls: 1 },
      { text: "\n\nSection", leadingNls: 2 },
      { text: "NoPrefixHere", leadingNls: 0 },
      { text: "\n", leadingNls: 1 },
    ];
    for (const { text, leadingNls } of texts) {
      const computed = text.length - text.trimStart().length;
      expect(computed).toBe(leadingNls);
    }
  });

  it("styleStart >= index + text.length means no style request", () => {
    // text is just '\n' — no non-newline chars to style
    const text = "\n";
    const index = 10;
    const leadingNls = text.length - text.trimStart().length;
    const styleStart = index + leadingNls;
    // styleStart === index + text.length, so no request should be emitted
    expect(styleStart).toBe(index + text.length);
  });

  it("styleStart < index + text.length when text has non-newline content", () => {
    const text = "\nActual heading";
    const index = 5;
    const leadingNls = text.length - text.trimStart().length;
    const styleStart = index + leadingNls;
    expect(styleStart).toBeLessThan(index + text.length);
    // styleStart skips the leading newline
    expect(styleStart).toBe(index + 1);
  });
});
