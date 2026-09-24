import { describe, it, expect } from "vitest";
import type { forms_v1, script_v1 } from "googleapis";
import {
  buildAddQuestionRequest,
  flattenResponses,
  questionTitleMap,
} from "../src/tools/forms.js";
import { mergeScriptFiles } from "../src/tools/script.js";

// ---------------------------------------------------------------------------
// Forms: add_question request builder
// ---------------------------------------------------------------------------

describe("buildAddQuestionRequest", () => {
  it("SHORT_TEXT -> textQuestion paragraph=false", () => {
    const req = buildAddQuestionRequest({
      title: "Name?",
      type: "SHORT_TEXT",
      index: 0,
    });
    expect(req).toEqual({
      createItem: {
        item: {
          title: "Name?",
          questionItem: {
            question: { required: false, textQuestion: { paragraph: false } },
          },
        },
        location: { index: 0 },
      },
    });
  });

  it("PARAGRAPH -> textQuestion paragraph=true, honors required + description", () => {
    const req = buildAddQuestionRequest({
      title: "Feedback",
      type: "PARAGRAPH",
      index: 2,
      required: true,
      description: "Tell us more",
    });
    expect(req.createItem?.item?.description).toBe("Tell us more");
    expect(req.createItem?.item?.questionItem?.question).toEqual({
      required: true,
      textQuestion: { paragraph: true },
    });
    expect(req.createItem?.location?.index).toBe(2);
  });

  it("MULTIPLE_CHOICE -> choiceQuestion RADIO with options", () => {
    const req = buildAddQuestionRequest({
      title: "Pick one",
      type: "MULTIPLE_CHOICE",
      index: 1,
      options: ["A", "B"],
    });
    expect(req.createItem?.item?.questionItem?.question?.choiceQuestion).toEqual({
      type: "RADIO",
      options: [{ value: "A" }, { value: "B" }],
    });
  });

  it("CHECKBOXES -> CHECKBOX, DROPDOWN -> DROP_DOWN", () => {
    const cb = buildAddQuestionRequest({
      title: "Many",
      type: "CHECKBOXES",
      index: 0,
      options: ["X"],
    });
    expect(
      cb.createItem?.item?.questionItem?.question?.choiceQuestion?.type
    ).toBe("CHECKBOX");
    const dd = buildAddQuestionRequest({
      title: "Drop",
      type: "DROPDOWN",
      index: 0,
      options: ["X"],
    });
    expect(
      dd.createItem?.item?.questionItem?.question?.choiceQuestion?.type
    ).toBe("DROP_DOWN");
  });

  it("choice types without options throw", () => {
    expect(() =>
      buildAddQuestionRequest({ title: "x", type: "DROPDOWN", index: 0 })
    ).toThrow(/options/);
  });

  it("LINEAR_SCALE -> scaleQuestion with labels", () => {
    const req = buildAddQuestionRequest({
      title: "Rate",
      type: "LINEAR_SCALE",
      index: 0,
      scale: { low: 1, high: 5, lowLabel: "Bad", highLabel: "Good" },
    });
    expect(req.createItem?.item?.questionItem?.question?.scaleQuestion).toEqual({
      low: 1,
      high: 5,
      lowLabel: "Bad",
      highLabel: "Good",
    });
  });

  it("LINEAR_SCALE without scale throws", () => {
    expect(() =>
      buildAddQuestionRequest({ title: "x", type: "LINEAR_SCALE", index: 0 })
    ).toThrow(/scale/);
  });

  it("DATE -> dateQuestion, TIME -> timeQuestion", () => {
    const d = buildAddQuestionRequest({ title: "When", type: "DATE", index: 0 });
    expect(
      d.createItem?.item?.questionItem?.question?.dateQuestion
    ).toBeDefined();
    const t = buildAddQuestionRequest({ title: "What time", type: "TIME", index: 0 });
    expect(
      t.createItem?.item?.questionItem?.question?.timeQuestion
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Forms: response flattening
// ---------------------------------------------------------------------------

describe("flattenResponses", () => {
  const items: forms_v1.Schema$Item[] = [
    {
      itemId: "i1",
      title: "Favorite color",
      questionItem: { question: { questionId: "q_color" } },
    },
    {
      itemId: "i2",
      title: "Name",
      questionItem: { question: { questionId: "q_name" } },
    },
    {
      itemId: "i3",
      title: "Toppings",
      questionItem: { question: { questionId: "q_top" } },
    },
  ];

  it("builds questionId -> title map", () => {
    expect(questionTitleMap(items)).toEqual({
      q_color: "Favorite color",
      q_name: "Name",
      q_top: "Toppings",
    });
  });

  it("flattens choice (single), text, and checkbox (array) answers keyed by title", () => {
    const responses: forms_v1.Schema$FormResponse[] = [
      {
        responseId: "r1",
        createTime: "2026-02-01T10:00:00Z",
        respondentEmail: "user@example.com",
        answers: {
          q_color: { questionId: "q_color", textAnswers: { answers: [{ value: "Blue" }] } },
          q_name: { questionId: "q_name", textAnswers: { answers: [{ value: "Jan" }] } },
          q_top: {
            questionId: "q_top",
            textAnswers: { answers: [{ value: "Cheese" }, { value: "Ham" }] },
          },
        },
      },
    ];
    const flat = flattenResponses(responses, questionTitleMap(items));
    expect(flat).toEqual([
      {
        responseId: "r1",
        createTime: "2026-02-01T10:00:00Z",
        respondentEmail: "user@example.com",
        answers: {
          "Favorite color": "Blue",
          Name: "Jan",
          Toppings: ["Cheese", "Ham"],
        },
      },
    ]);
  });

  it("falls back to questionId when title is unknown and omits missing email", () => {
    const flat = flattenResponses(
      [
        {
          responseId: "r2",
          answers: {
            unknown_q: {
              questionId: "unknown_q",
              textAnswers: { answers: [{ value: "42" }] },
            },
          },
        },
      ],
      {}
    );
    expect(flat[0].answers).toEqual({ unknown_q: "42" });
    expect(flat[0].respondentEmail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Apps Script: file merge logic
// ---------------------------------------------------------------------------

describe("mergeScriptFiles", () => {
  const existing: script_v1.Schema$File[] = [
    { name: "appsscript", type: "JSON", source: '{"timeZone":"UTC"}' },
    { name: "Code", type: "SERVER_JS", source: "function old(){}" },
    { name: "Page", type: "HTML", source: "<p>old</p>" },
  ];

  it("merges: replaces by name, adds new, keeps others (default)", () => {
    const merged = mergeScriptFiles(
      existing,
      [
        { name: "Code", type: "SERVER_JS", source: "function neu(){}" },
        { name: "Extra", type: "SERVER_JS", source: "function extra(){}" },
      ],
      false
    );
    const byName = Object.fromEntries(merged.map((f) => [f.name, f.source]));
    expect(byName["Code"]).toBe("function neu(){}"); // replaced
    expect(byName["Page"]).toBe("<p>old</p>"); // kept
    expect(byName["Extra"]).toBe("function extra(){}"); // added
    expect(byName["appsscript"]).toBe('{"timeZone":"UTC"}'); // manifest kept
    expect(merged).toHaveLength(4);
  });

  it("carries over the existing manifest when the caller omits it", () => {
    const merged = mergeScriptFiles(
      existing,
      [{ name: "Code", type: "SERVER_JS", source: "x" }],
      false
    );
    expect(merged.some((f) => f.name === "appsscript")).toBe(true);
  });

  it("replaceAll sends exactly the provided set but still preserves the manifest", () => {
    const merged = mergeScriptFiles(
      existing,
      [{ name: "Only", type: "SERVER_JS", source: "function only(){}" }],
      true
    );
    const names = merged.map((f) => f.name).sort();
    expect(names).toEqual(["Only", "appsscript"]);
  });

  it("replaceAll uses a provided manifest verbatim (no carry-over)", () => {
    const merged = mergeScriptFiles(
      existing,
      [
        { name: "appsscript", type: "JSON", source: '{"timeZone":"Europe/Prague"}' },
        { name: "Only", type: "SERVER_JS", source: "x" },
      ],
      true
    );
    const manifest = merged.find((f) => f.name === "appsscript");
    expect(manifest?.source).toBe('{"timeZone":"Europe/Prague"}');
    expect(merged).toHaveLength(2);
  });
});
