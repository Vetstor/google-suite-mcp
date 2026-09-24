/**
 * Tool-tier taxonomy for the Google Workspace MCP server.
 *
 * - read       : safe, idempotent queries (list_*, get_*, read_*, find_*, thumbnail, processes)
 * - write      : creates or modifies data, but reversible or non-destructive
 * - destructive: irreversible deletions / raw batchUpdate that can wipe anything
 */
export type Tier = "read" | "write" | "destructive";

export const TOOL_TIERS: Record<string, Tier> = {
  // ── Sheets: Drive / listing ──────────────────────────────────────────────
  list_spreadsheets: "read",
  // ── Sheets: metadata ────────────────────────────────────────────────────
  get_spreadsheet: "read",
  create_spreadsheet: "write",
  add_sheet: "write",
  delete_sheet: "destructive",
  // ── Sheets: values ──────────────────────────────────────────────────────
  read_range: "read",
  batch_read: "read",
  write_range: "write",
  batch_write: "write",
  append_rows: "write",
  clear_range: "destructive",
  find_cells: "read",
  // ── Sheets: advanced ────────────────────────────────────────────────────
  batch_update_raw: "destructive",
  // ── Docs ────────────────────────────────────────────────────────────────
  list_documents: "read",
  get_document: "read",
  create_document: "write",
  append_text: "write",
  insert_text: "write",
  replace_text: "write",
  batch_update_docs_raw: "destructive",
  // ── Slides ──────────────────────────────────────────────────────────────
  list_presentations: "read",
  get_presentation: "read",
  create_presentation: "write",
  add_slide: "write",
  replace_text_in_presentation: "write",
  insert_text_box: "write",
  insert_image: "write",
  delete_slide: "destructive",
  get_slide_thumbnail: "read",
  batch_update_slides_raw: "destructive",
  // ── Forms ────────────────────────────────────────────────────────────────
  list_forms: "read",
  get_form: "read",
  create_form: "write",
  add_question: "write",
  update_form_info: "write",
  delete_item: "destructive",
  list_responses: "read",
  batch_update_forms_raw: "destructive",
  // ── Apps Script ──────────────────────────────────────────────────────────
  list_script_projects: "read",
  create_script_project: "write",
  get_script_project: "read",
  update_script_content: "write",
  list_script_versions: "read",
  create_script_version: "write",
  list_script_deployments: "read",
  create_script_deployment: "write",
  run_script_function: "write",
  get_script_processes: "read",
};
