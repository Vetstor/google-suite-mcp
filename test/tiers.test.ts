import { describe, it, expect } from "vitest";
import { TOOL_TIERS } from "../src/tools/tiers.js";

// ---------------------------------------------------------------------------
// These are the 48 tool names that must all have a tier entry.
// They come from the EXPECTED_TOOLS list in mcp.test.ts — keep in sync.
// ---------------------------------------------------------------------------
const ALL_TOOLS = [
  // Sheets
  "list_spreadsheets",
  "get_spreadsheet",
  "create_spreadsheet",
  "add_sheet",
  "delete_sheet",
  "read_range",
  "batch_read",
  "write_range",
  "batch_write",
  "append_rows",
  "clear_range",
  "find_cells",
  "batch_update_raw",
  // Docs
  "list_documents",
  "get_document",
  "create_document",
  "append_text",
  "insert_text",
  "replace_text",
  "batch_update_docs_raw",
  // Slides
  "list_presentations",
  "get_presentation",
  "create_presentation",
  "add_slide",
  "replace_text_in_presentation",
  "insert_text_box",
  "insert_image",
  "delete_slide",
  "get_slide_thumbnail",
  "batch_update_slides_raw",
  // Forms
  "list_forms",
  "get_form",
  "create_form",
  "add_question",
  "update_form_info",
  "delete_item",
  "list_responses",
  "batch_update_forms_raw",
  // Apps Script
  "list_script_projects",
  "create_script_project",
  "get_script_project",
  "update_script_content",
  "list_script_versions",
  "create_script_version",
  "list_script_deployments",
  "create_script_deployment",
  "run_script_function",
  "get_script_processes",
];

describe("TOOL_TIERS coverage", () => {
  it("every registered tool has a tier entry", () => {
    const missing = ALL_TOOLS.filter((name) => !(name in TOOL_TIERS));
    expect(missing, `Missing tier entries: ${missing.join(", ")}`).toHaveLength(0);
  });

  it("every tier entry corresponds to a registered tool (no drift)", () => {
    const extra = Object.keys(TOOL_TIERS).filter(
      (name) => !ALL_TOOLS.includes(name)
    );
    expect(extra, `Extra tier entries not in tool list: ${extra.join(", ")}`).toHaveLength(0);
  });

  it("tier values are valid", () => {
    const valid = new Set(["read", "write", "destructive"]);
    for (const [name, tier] of Object.entries(TOOL_TIERS)) {
      expect(valid.has(tier), `${name} has invalid tier "${tier}"`).toBe(true);
    }
  });

  it("read-tier tools have expected names", () => {
    const readTools = Object.entries(TOOL_TIERS)
      .filter(([, t]) => t === "read")
      .map(([n]) => n)
      .sort();

    // Spot-check key read tools
    expect(readTools).toContain("list_spreadsheets");
    expect(readTools).toContain("read_range");
    expect(readTools).toContain("batch_read");
    expect(readTools).toContain("find_cells");
    expect(readTools).toContain("get_slide_thumbnail");
    expect(readTools).toContain("list_responses");
    expect(readTools).toContain("get_script_processes");
  });

  it("destructive-tier tools are the raw batchUpdate + delete tools", () => {
    const destructive = Object.entries(TOOL_TIERS)
      .filter(([, t]) => t === "destructive")
      .map(([n]) => n)
      .sort();

    expect(destructive).toContain("batch_update_raw");
    expect(destructive).toContain("batch_update_docs_raw");
    expect(destructive).toContain("batch_update_slides_raw");
    expect(destructive).toContain("batch_update_forms_raw");
    expect(destructive).toContain("delete_sheet");
    expect(destructive).toContain("delete_slide");
    expect(destructive).toContain("delete_item");
    expect(destructive).toContain("clear_range");
    // No write tools in destructive
    for (const name of destructive) {
      expect(TOOL_TIERS[name]).toBe("destructive");
    }
  });
});
