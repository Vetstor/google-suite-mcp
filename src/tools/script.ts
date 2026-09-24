import { z } from "zod";
import type { script_v1 } from "googleapis";
import {
  handleGoogleError,
  jsonResult,
  defineTool,
  type RegisterCtx,
} from "../helpers.js";

const MANIFEST_NAME = "appsscript";

const ScriptFileType = z.enum(["SERVER_JS", "JSON", "HTML"]);

const ScriptFile = z.object({
  name: z
    .string()
    .describe("File name WITHOUT extension (e.g. 'Code', 'appsscript')."),
  type: ScriptFileType.describe("SERVER_JS | JSON | HTML."),
  source: z.string().describe("Full file source."),
});
type ScriptFile = z.infer<typeof ScriptFile>;

export function mergeScriptFiles(
  existing: script_v1.Schema$File[],
  provided: ScriptFile[],
  replaceAll: boolean
): script_v1.Schema$File[] {
  const result: script_v1.Schema$File[] = replaceAll
    ? []
    : existing.map((f) => ({ name: f.name, type: f.type, source: f.source }));

  for (const file of provided) {
    const idx = result.findIndex((f) => f.name === file.name);
    if (idx >= 0) result[idx] = { ...file };
    else result.push({ ...file });
  }

  if (!result.some((f) => f.name === MANIFEST_NAME)) {
    const existingManifest = existing.find((f) => f.name === MANIFEST_NAME);
    if (existingManifest) {
      result.push({
        name: existingManifest.name,
        type: existingManifest.type,
        source: existingManifest.source,
      });
    }
  }
  return result;
}

const RUN_HINT =
  "Note: scripts.run only works when the script's GCP project matches this server's OAuth client project AND the script has an 'API Executable' deployment; most user scripts do not qualify. Each user must also enable the Apps Script API at https://script.google.com/home/usersettings.";

export function registerScriptTools(ctx: RegisterCtx) {
  defineTool(
    ctx,
    "list_script_projects",
    {
      description:
        "List Google Apps Script projects accessible to the caller. Optionally filter by name (substring) or Drive folder.",
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
        let q = "mimeType='application/vnd.google-apps.script' and trashed=false";
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
        return handleGoogleError(err, "list_script_projects");
      }
    }
  );

  defineTool(
    ctx,
    "create_script_project",
    {
      description:
        "Create a new Apps Script project. Pass parentId (a Sheet/Doc/Form/Slides file ID) to create a container-bound script; omit it for a standalone script. Returns {scriptId, editorUrl}.",
      inputSchema: {
        title: z.string().describe("Title of the new script project."),
        parentId: z
          .string()
          .optional()
          .describe(
            "Drive ID of a Sheet/Doc/Form/Slides file to bind the script to (standalone if omitted)."
          ),
      },
    },
    async ({ title, parentId }) => {
      try {
        const { script } = await ctx.getClients();
        const res = await script.projects.create({
          requestBody: { title, parentId },
        });
        const scriptId = res.data.scriptId!;
        return jsonResult({
          scriptId,
          editorUrl: `https://script.google.com/d/${scriptId}/edit`,
        });
      } catch (err) {
        return handleGoogleError(err, "create_script_project");
      }
    }
  );

  defineTool(
    ctx,
    "get_script_project",
    {
      description:
        "Get an Apps Script project's metadata + source files: {scriptId, title, parentId?, files:[{name, type (SERVER_JS|JSON|HTML), source}]}.",
      inputSchema: {
        scriptId: z.string().describe("The script project's Drive ID."),
      },
    },
    async ({ scriptId }) => {
      try {
        const { script } = await ctx.getClients();
        const [meta, content] = await Promise.all([
          script.projects.get({ scriptId }),
          script.projects.getContent({ scriptId }),
        ]);
        const out: Record<string, unknown> = {
          scriptId: meta.data.scriptId,
          title: meta.data.title,
          files: (content.data.files ?? []).map((f) => ({
            name: f.name,
            type: f.type,
            source: f.source,
          })),
        };
        if (meta.data.parentId) out.parentId = meta.data.parentId;
        return jsonResult(out);
      } catch (err) {
        return handleGoogleError(err, "get_script_project");
      }
    }
  );

  defineTool(
    ctx,
    "update_script_content",
    {
      description:
        "Update an Apps Script project's files. By default this MERGES: existing files are fetched, files with the same name are replaced, new files are added, and untouched files are kept. The required 'appsscript' JSON manifest is always preserved (carried over if you omit it). Set replaceAll=true to send exactly the provided set instead (the manifest is still carried over if omitted). Returns the resulting file names.",
      inputSchema: {
        scriptId: z.string().describe("The script project's Drive ID."),
        files: z
          .array(ScriptFile)
          .describe("Files to write (name has no extension)."),
        replaceAll: z
          .boolean()
          .default(false)
          .describe(
            "Replace the whole file set instead of merging (default false)."
          ),
      },
    },
    async ({ scriptId, files, replaceAll }) => {
      try {
        const { script } = await ctx.getClients();
        const current = await script.projects.getContent({ scriptId });
        const merged = mergeScriptFiles(
          current.data.files ?? [],
          files,
          replaceAll
        );
        const res = await script.projects.updateContent({
          scriptId,
          requestBody: { files: merged },
        });
        return jsonResult({
          scriptId,
          files: (res.data.files ?? []).map((f) => f.name),
        });
      } catch (err) {
        return handleGoogleError(err, "update_script_content");
      }
    }
  );

  defineTool(
    ctx,
    "list_script_versions",
    {
      description:
        "List an Apps Script project's saved versions. Returns versions with versionNumber, description, createTime.",
      inputSchema: {
        scriptId: z.string().describe("The script project's Drive ID."),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max per page."),
        pageToken: z.string().optional().describe("Page token from a prior call."),
      },
    },
    async ({ scriptId, pageSize, pageToken }) => {
      try {
        const { script } = await ctx.getClients();
        const res = await script.projects.versions.list({
          scriptId,
          pageSize,
          pageToken,
        });
        return jsonResult({
          versions: res.data.versions ?? [],
          nextPageToken: res.data.nextPageToken ?? undefined,
        });
      } catch (err) {
        return handleGoogleError(err, "list_script_versions");
      }
    }
  );

  defineTool(
    ctx,
    "create_script_version",
    {
      description:
        "Create an immutable version (snapshot) of an Apps Script project. Deployments reference a version. Returns {scriptId, versionNumber, description}.",
      inputSchema: {
        scriptId: z.string().describe("The script project's Drive ID."),
        description: z
          .string()
          .optional()
          .describe("Description for this version."),
      },
    },
    async ({ scriptId, description }) => {
      try {
        const { script } = await ctx.getClients();
        const res = await script.projects.versions.create({
          scriptId,
          requestBody: { description },
        });
        return jsonResult({
          scriptId,
          versionNumber: res.data.versionNumber,
          description: res.data.description,
        });
      } catch (err) {
        return handleGoogleError(err, "create_script_version");
      }
    }
  );

  defineTool(
    ctx,
    "list_script_deployments",
    {
      description:
        "List an Apps Script project's deployments. Returns deployments with deploymentId, config, entry points.",
      inputSchema: {
        scriptId: z.string().describe("The script project's Drive ID."),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max per page."),
        pageToken: z.string().optional().describe("Page token from a prior call."),
      },
    },
    async ({ scriptId, pageSize, pageToken }) => {
      try {
        const { script } = await ctx.getClients();
        const res = await script.projects.deployments.list({
          scriptId,
          pageSize,
          pageToken,
        });
        return jsonResult({
          deployments: res.data.deployments ?? [],
          nextPageToken: res.data.nextPageToken ?? undefined,
        });
      } catch (err) {
        return handleGoogleError(err, "list_script_deployments");
      }
    }
  );

  defineTool(
    ctx,
    "create_script_deployment",
    {
      description:
        "Deploy a version of an Apps Script project. Requires an existing versionNumber (create one with create_script_version). Returns {scriptId, deploymentId, versionNumber}.",
      inputSchema: {
        scriptId: z.string().describe("The script project's Drive ID."),
        versionNumber: z
          .number()
          .int()
          .describe(
            "The version number to deploy (from create_script_version)."
          ),
        description: z
          .string()
          .optional()
          .describe("Description for the deployment."),
        manifestFileName: z
          .string()
          .default("appsscript")
          .describe("Manifest file name (default 'appsscript')."),
      },
    },
    async ({ scriptId, versionNumber, description, manifestFileName }) => {
      try {
        const { script } = await ctx.getClients();
        const res = await script.projects.deployments.create({
          scriptId,
          requestBody: { versionNumber, description, manifestFileName },
        });
        return jsonResult({
          scriptId,
          deploymentId: res.data.deploymentId,
          versionNumber:
            res.data.deploymentConfig?.versionNumber ?? versionNumber,
        });
      } catch (err) {
        return handleGoogleError(err, "create_script_deployment");
      }
    }
  );

  defineTool(
    ctx,
    "run_script_function",
    {
      description: `Execute a function in an Apps Script project via the Apps Script API. ${RUN_HINT} Returns the function's result, or a clear error with the script stack trace on failure.`,
      inputSchema: {
        scriptId: z
          .string()
          .describe(
            "The script ID (or API Executable deployment ID) to run."
          ),
        function: z
          .string()
          .describe("The function name to execute (no parentheses)."),
        parameters: z
          .array(z.unknown())
          .optional()
          .describe("Primitive parameters passed to the function."),
        devMode: z
          .boolean()
          .default(false)
          .describe(
            "Run the latest saved code (owner only) instead of the deployed version. Default false."
          ),
      },
    },
    async ({ scriptId, function: fn, parameters, devMode }) => {
      try {
        const { script } = await ctx.getClients();
        const res = await script.scripts.run({
          scriptId,
          requestBody: { function: fn, parameters, devMode },
        });
        if (res.data.error) {
          const status = res.data.error;
          const detail = (status.details?.[0] ?? {}) as {
            errorMessage?: string;
            errorType?: string;
            scriptStackTraceElements?: Array<{
              function?: string;
              lineNumber?: number;
            }>;
          };
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  `run_script_function: script error` +
                  `${detail.errorType ? ` (${detail.errorType})` : ""}: ` +
                  `${detail.errorMessage ?? status.message ?? "unknown error"}\n` +
                  `Stack: ${JSON.stringify(
                    detail.scriptStackTraceElements ?? [],
                    null,
                    2
                  )}`,
              },
            ],
          };
        }
        return jsonResult({ scriptId, result: res.data.response?.result });
      } catch (err) {
        return handleGoogleError(err, `run_script_function. ${RUN_HINT}`);
      }
    }
  );

  defineTool(
    ctx,
    "get_script_processes",
    {
      description:
        "List recent executions (processes) for an Apps Script project, with function name, type, status and timing. Optional pageSize.",
      inputSchema: {
        scriptId: z.string().describe("The script project's Drive ID."),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max processes to return."),
        pageToken: z.string().optional().describe("Page token from a prior call."),
      },
    },
    async ({ scriptId, pageSize, pageToken }) => {
      try {
        const { script } = await ctx.getClients();
        const res = await script.processes.listScriptProcesses({
          scriptId,
          pageSize,
          pageToken,
        });
        return jsonResult({
          processes: res.data.processes ?? [],
          nextPageToken: res.data.nextPageToken ?? undefined,
        });
      } catch (err) {
        return handleGoogleError(err, "get_script_processes");
      }
    }
  );
}
