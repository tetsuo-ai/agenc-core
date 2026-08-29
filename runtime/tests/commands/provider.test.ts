import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  providerCommand,
  applyProviderSwitch,
  checkModelHistoryCompat,
} from "./provider.js";
import { readProviderMenuSnapshot } from "./provider-menu.js";
import type { Session } from "../session/session.js";
import type {
  SlashCommandAppStateBridge,
  SlashCommandContext,
} from "./types.js";
import type { EnvSnapshot } from "../config/env.js";
import type { ConfigStore } from "../config/store.js";
import { resolveHomeContext, type HomeContext } from "../config/home.js";
import { RemoteAuthBackend } from "../auth/backends/remote.js";
import { LocalAuthBackend } from "../auth/backends/local.js";
import { saveXaiOauthCredentials } from "../utils/xaiOauthCredentials.js";
import { subscriptionManagedDefaultModelForTier } from "./subscription-managed-models.js";
import { modelCommand } from "./model.js";

const TEST_ENVIRONMENT: EnvSnapshot = Object.freeze({
  AGENC_HOME: "/tmp/agenc-provider-command-test",
});
const TEST_HOME = resolveHomeContext(TEST_ENVIRONMENT, {
  platformHome: "/tmp",
});

type CommandConfigStore = Pick<ConfigStore, "current" | "homeContext">;

interface CommandAuthority {
  readonly configStore: CommandConfigStore;
  readonly environment: EnvSnapshot;
}

function commandConfigStore(
  homeContext: HomeContext = TEST_HOME,
  config: unknown = {},
): CommandConfigStore {
  return {
    homeContext,
    current: () => config as ReturnType<ConfigStore["current"]>,
  };
}

interface StubSessionOpts {
  provider?: string;
  model?: string;
  activeTurn?: unknown;
  abortTerminal?: ReturnType<typeof vi.fn>;
  pendingProviderSwitch?: unknown;
  history?: unknown[];
  configModelByProvider?: Record<string, string>;
  configStore?: CommandConfigStore;
  environment?: EnvSnapshot;
  providerServiceSelection?: {
    readonly provider?: unknown;
    readonly model?: unknown;
  };
}

function stubSession(opts: StubSessionOpts = {}): Session {
  const sessionConfiguration = {
    provider: { slug: opts.provider ?? "grok" },
    collaborationMode: { model: opts.model ?? "grok-4" },
  };
  const abortTerminal = opts.abortTerminal ?? vi.fn();
  const s: {
    state: { unsafePeek: () => unknown };
    activeTurn: { unsafePeek: () => unknown };
    abortTerminal: ReturnType<typeof vi.fn>;
    pendingProviderSwitch: unknown;
    services: {
      configStore: CommandConfigStore;
      providerEnvironment: EnvSnapshot;
      providerService?: {
        current: () => {
          readonly provider?: unknown;
          readonly model?: unknown;
        };
      };
    };
    setPendingProviderSwitch(next: unknown): void;
  } = {
    state: {
      unsafePeek: () => ({
        sessionConfiguration,
        history: opts.history ?? [],
      }),
    },
    activeTurn: { unsafePeek: () => opts.activeTurn ?? null },
    abortTerminal,
    pendingProviderSwitch: opts.pendingProviderSwitch ?? null,
    services: {
      configStore:
        opts.configStore ??
        commandConfigStore(
          TEST_HOME,
          opts.configModelByProvider
            ? {
                providers: Object.fromEntries(
                  Object.entries(opts.configModelByProvider).map(
                    ([provider, model]) => [provider, { default_model: model }],
                  ),
                ),
              }
            : {},
        ),
      providerEnvironment: opts.environment ?? TEST_ENVIRONMENT,
      ...(opts.providerServiceSelection !== undefined
        ? {
            providerService: {
              current: () => opts.providerServiceSelection!,
            },
          }
        : {}),
    },
    setPendingProviderSwitch(next) {
      this.pendingProviderSwitch = next;
    },
  };
  return s as unknown as Session;
}

function mkctx(
  session: Session,
  argsRaw = "",
  appState?: SlashCommandAppStateBridge,
): SlashCommandContext {
  return {
    session,
    argsRaw,
    cwd: "/ws",
    home: "/home/test",
    ...(appState ? { appState } : {}),
  };
}

function bedrockProviderMenuRow(environment: EnvSnapshot) {
  const snapshot = readProviderMenuSnapshot(
    mkctx(
      stubSession({
        environment: Object.freeze({
          ...TEST_ENVIRONMENT,
          ...environment,
        }),
      }),
      "",
    ),
  );
  const row = snapshot.rows.find(
    (candidate) => candidate.provider === "amazon-bedrock",
  );
  if (row === undefined) {
    throw new Error("Amazon Bedrock provider row is missing");
  }
  return row;
}

async function withAuthSession<T>(
  tier: "free" | "pro",
  fn: (authority: CommandAuthority) => T | Promise<T>,
): Promise<T> {
  const agencHome = mkdtempSync(join(tmpdir(), `agenc-provider-${tier}-`));
  const environment: EnvSnapshot = Object.freeze({ AGENC_HOME: agencHome });
  const homeContext = resolveHomeContext(environment, {
    platformHome: tmpdir(),
  });
  const backend = new RemoteAuthBackend({
    agencHome,
    env: environment,
    loginFlow: () => ({
      token: "test-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      subscriptionTier: tier,
    }),
    now: () => new Date("2026-08-24T00:00:00.000Z"),
  });
  let signedIn = false;
  try {
    await backend.login();
    signedIn = true;
    return await fn({
      environment,
      configStore: commandConfigStore(homeContext, {
        auth: { managedKeys: { enabled: true } },
      }),
    });
  } finally {
    try {
      if (signedIn) await backend.logout();
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  }
}

async function withProAuthSession<T>(
  fn: (authority: CommandAuthority) => T | Promise<T>,
): Promise<T> {
  return withAuthSession("pro", fn);
}

describe("providerCommand", () => {
  it("is userInvocable and immediate", () => {
    expect(providerCommand.userInvocable).toBe(true);
    expect(providerCommand.immediate).toBe(true);
    expect(providerCommand.name).toBe("provider");
    expect(providerCommand.aliases).toBeUndefined();
  });

  it("re-exports the live I-57 implementation", () => {
    const session = stubSession({
      provider: "openai",
      model: "gpt-5",
      history: [
        {
          role: "assistant",
          content: [{ type: "reasoning", summary: [] }],
        },
      ],
    });
    const compat = checkModelHistoryCompat(session, "gpt-5", "ollama");
    expect(compat.compatible).toBe(false);
    expect(compat.missingCapabilities).toEqual(["thinking history"]);
  });

  it("returns a provider list when args are empty outside the TUI", async () => {
    const session = stubSession();
    const res = await providerCommand.execute(mkctx(session, ""));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toContain("Provider selection");
      expect(res.text).toContain("Current: grok / grok-4");
      expect(res.text).toContain("ollama");
    }
  });

  it("opens the local provider menu when args are empty in the TUI", async () => {
    const session = stubSession();
    const setToolJSX = vi.fn();
    const res = await providerCommand.execute(
      mkctx(session, "", {
        getAppState: () => ({ mainLoopModel: "grok-4" }),
        setToolJSX,
      }),
    );
    expect(res.kind).toBe("skip");
    expect(setToolJSX).toHaveBeenCalledTimes(1);
    expect(setToolJSX.mock.calls[0]?.[0]).toMatchObject({
      isLocalJSXCommand: true,
      shouldHidePromptInput: true,
    });
  });

  it("rejects a provider picker row whose model belongs to another provider", async () => {
    const session = stubSession();
    const setModel = vi.fn();
    const setToolJSX = vi.fn();
    await providerCommand.execute(
      mkctx(session, "", { setModel, setToolJSX }),
    );
    const payload = setToolJSX.mock.calls[0]?.[0] as unknown as {
      jsx?: {
        props?: {
          onSelect?: (
            provider: "grok",
            model: string,
          ) => Promise<{ message: string; shouldClose: boolean }>;
        };
      };
    };
    const onSelect = payload.jsx?.props?.onSelect;
    if (onSelect === undefined) throw new Error("provider picker missing onSelect");

    await expect(onSelect("grok", "gpt-5")).resolves.toMatchObject({
      message: expect.stringContaining("belongs to provider 'openai'"),
      shouldClose: false,
    });
    expect(setModel).not.toHaveBeenCalled();
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toBeNull();
  });

  it("applies the provider default model immediately when no turn is active", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4",
      activeTurn: null,
    });
    const res = await providerCommand.execute(mkctx(session, "ollama"));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/ollama/);
      expect(res.text).toMatch(/model "llama3\.3"/);
    }
    const pending = (
      session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }
    ).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "ollama", model: "llama3.3" });
  });

  it("updates TUI model chrome when provider switch selects a model", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4",
      activeTurn: null,
    });
    const setModel = vi.fn();
    const res = await providerCommand.execute(
      mkctx(session, "ollama", { setModel }),
    );
    expect(res.kind).toBe("text");
    expect(setModel).toHaveBeenCalledWith("llama3.3");
  });

  it("updates app state without overwriting the pending provider switch", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4",
      activeTurn: null,
    });
    const setModel = vi.fn();
    let appState: unknown = {
      mainLoopModel: "grok-4",
      mainLoopModelForSession: "grok-4",
    };
    const setAppState = vi.fn((updater: (prev: unknown) => unknown) => {
      appState = updater(appState);
    });

    const res = await providerCommand.execute(
      mkctx(session, "ollama", { setModel, setAppState }),
    );

    expect(res.kind).toBe("text");
    expect(setModel).not.toHaveBeenCalled();
    expect(appState).toMatchObject({
      mainLoopModel: "llama3.3",
      mainLoopModelForSession: "llama3.3",
    });
    const pending = (
      session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }
    ).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "ollama", model: "llama3.3" });
  });

  it("uses an explicit model when the picker submits provider and model", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4",
    });
    const res = await providerCommand.execute(mkctx(session, "openai gpt-5"));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/openai/);
      expect(res.text).toMatch(/gpt-5/);
    }
    const pending = (
      session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }
    ).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "openai", model: "gpt-5" });
  });

  it("prefers configured provider defaults when available", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4",
      configModelByProvider: {
        openai: "gpt-5-mini",
      },
    });
    await providerCommand.execute(mkctx(session, "openai"));
    const pending = (
      session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }
    ).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "openai", model: "gpt-5-mini" });
  });

  it("restores the configured top-level pair after a temporary provider switch", async () => {
    const configStore = commandConfigStore(TEST_HOME, {
      model_provider: "openai",
      model: "gpt-5-mini",
    });
    const session = stubSession({
      provider: "grok",
      model: "grok-4.3",
      configStore,
    });
    const openaiRow = readProviderMenuSnapshot(mkctx(session)).rows.find(
      (row) => row.provider === "openai",
    );

    await providerCommand.execute(mkctx(session, "openai"));

    expect(openaiRow?.model).toBe("gpt-5-mini");
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toEqual({ provider: "openai", model: "gpt-5-mini" });
  });

  it("uses the same configured provider pair for menu, stage, and chrome", async () => {
    const session = stubSession({
      provider: "grok",
      model: "grok-4",
      configModelByProvider: { openai: "gpt-5-mini" },
    });
    const openaiRow = readProviderMenuSnapshot(mkctx(session)).rows.find(
      (row) => row.provider === "openai",
    );
    if (openaiRow === undefined) throw new Error("OpenAI menu row is missing");
    const setModel = vi.fn();

    await providerCommand.execute(mkctx(session, "openai", { setModel }));

    expect(openaiRow.model).toBe("gpt-5-mini");
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toEqual({ provider: "openai", model: openaiRow.model });
    expect(setModel).toHaveBeenCalledWith(openaiRow.model);
  });

  it("stages pending switch + aborts current turn when I-13 applies", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({
      provider: "grok",
      model: "grok-4",
      activeTurn: { turnId: "t1" },
      abortTerminal,
    });
    const res = await providerCommand.execute(mkctx(session, "ollama"));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/staged/);
      expect(res.text).toMatch(/aborted/);
    }
    expect(abortTerminal).toHaveBeenCalledWith("provider_switched");
    const pending = (
      session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }
    ).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "ollama", model: "llama3.3" });
  });

  it("blocks the switch when the target provider cannot satisfy current history", async () => {
    const session = stubSession({
      provider: "openai",
      model: "gpt-5",
      history: [
        {
          role: "assistant",
          content: [{ type: "reasoning", summary: [] }],
        },
      ],
    });

    const res = await providerCommand.execute(mkctx(session, "ollama"));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/blocked/);
      expect(res.text).toMatch(/thinking history/);
    }
    const pending = (
      session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }
    ).pendingProviderSwitch;
    expect(pending).toBeNull();
  });

  it("does not update TUI model chrome when provider compatibility blocks the switch", async () => {
    const session = stubSession({
      provider: "openai",
      model: "gpt-5",
      history: [
        {
          role: "assistant",
          content: [{ type: "reasoning", summary: [] }],
        },
      ],
    });
    const setModel = vi.fn();

    const res = await providerCommand.execute(
      mkctx(session, "ollama", { setModel }),
    );

    expect(res.kind).toBe("text");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("applyProviderSwitch does not invoke abortTerminal when no turn is active", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({ abortTerminal });
    await applyProviderSwitch(session, "ollama");
    expect(abortTerminal).not.toHaveBeenCalled();
  });

  it("does not stage or abort an unchanged provider pair", async () => {
    const abortTerminal = vi.fn();
    const beforeStage = vi.fn();
    const session = stubSession({
      provider: "grok",
      model: "grok-4.6",
      activeTurn: { turnId: "active" },
      abortTerminal,
    });
    const stage = vi.spyOn(session, "setPendingProviderSwitch");

    await expect(
      applyProviderSwitch(session, "grok", "grok-4.6", { beforeStage }),
    ).resolves.toEqual({
      applied: false,
      provider: "grok",
      model: "grok-4.6",
      summary: "Provider unchanged: grok/grok-4.6.",
    });
    expect(stage).not.toHaveBeenCalled();
    expect(abortTerminal).not.toHaveBeenCalled();
    expect(beforeStage).not.toHaveBeenCalled();
  });

  it("blocks an impossible exact provider pair before staging", async () => {
    const session = stubSession();

    await expect(
      applyProviderSwitch(session, "grok", "gpt-5"),
    ).resolves.toMatchObject({
      applied: false,
      summary: expect.stringContaining("belongs to provider 'openai'"),
    });
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toBeNull();
  });

  it("blocks a provider default denied by managed policy before staging", async () => {
    const abortTerminal = vi.fn();
    const session = stubSession({
      provider: "grok",
      model: "grok-4",
      abortTerminal,
      configStore: commandConfigStore(TEST_HOME, {
        model_provider: "grok",
        model: "grok-4",
        availableModels: ["grok-4"],
      }),
    });

    await expect(
      applyProviderSwitch(session, "openai"),
    ).resolves.toMatchObject({
      applied: false,
      provider: "grok",
      model: "grok-4",
      summary: expect.stringContaining("managed availableModels policy"),
    });
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toBeNull();
    expect(abortTerminal).not.toHaveBeenCalled();
  });

  it("resolves a later unqualified model against the awaited provider successor", async () => {
    const session = stubSession({ provider: "grok", model: "grok-4.5" });
    const configuration = (
      session as unknown as {
        state: {
          unsafePeek(): {
            sessionConfiguration: {
              provider: { slug: string };
              collaborationMode: { model: string };
            };
          };
        };
      }
    ).state.unsafePeek().sessionConfiguration;
    const applyProviderModelSelection = vi.fn(
      async (selection: { readonly provider: string; readonly model: string }) => {
        configuration.provider.slug = selection.provider;
        configuration.collaborationMode.model = selection.model;
        return {
          applied: true,
          ...selection,
          summary: `Applied ${selection.provider}/${selection.model}`,
        };
      },
    );
    Object.assign(session, { applyProviderModelSelection });

    await providerCommand.execute(mkctx(session, "openai"));
    await modelCommand.execute(mkctx(session, "private-openai-model"));

    expect(applyProviderModelSelection).toHaveBeenNthCalledWith(1, {
      provider: "openai",
      model: "gpt-5",
    });
    expect(applyProviderModelSelection).toHaveBeenNthCalledWith(2, {
      provider: "openai",
      model: "private-openai-model",
    });
  });

  it("whitespace-only args are treated as empty", async () => {
    const res = await providerCommand.execute(mkctx(stubSession(), "   "));
    expect(res.kind).toBe("text");
  });

  it("does not mention branded references in output strings", async () => {
    const session = stubSession();
    const res = await providerCommand.execute(mkctx(session, "some-provider"));
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text.toLowerCase()).not.toContain(["cla", "ude"].join(""));
      expect(res.text.toLowerCase()).not.toContain("anthropic");
      expect(res.text.toLowerCase()).not.toContain("AgenC");
    }
  });

  it("provider menu snapshot exposes v2 auth and model availability state", () => {
    const snapshot = readProviderMenuSnapshot(mkctx(stubSession(), ""));
    const ollama = snapshot.rows.find((row) => row.provider === "ollama");
    const openai = snapshot.rows.find((row) => row.provider === "openai");

    expect(ollama).toMatchObject({
      runtimeState: "local",
      authState: "optional",
      model: "llama3.3",
    });
    expect(openai?.models.length).toBeGreaterThan(0);
    expect(openai?.credentialSource).toContain("OPENAI_API_KEY");
  });

  it("reads the current provider and model as one provider-service pair", () => {
    const configStore = commandConfigStore(TEST_HOME, {
      model_provider: "ollama",
      model: "llama3.3",
    });
    const snapshot = readProviderMenuSnapshot(
      mkctx(
        stubSession({
          provider: "grok",
          model: "grok-4",
          configStore,
          providerServiceSelection: {
            provider: "openai",
            model: "gpt-5",
          },
        }),
        "",
        {
          getAppState: () => ({ mainLoopModel: "stale-react-model" }),
        },
      ),
    );

    expect(snapshot.currentProvider).toBe("openai");
    expect(snapshot.currentModel).toBe("gpt-5");
    expect(snapshot.rows[snapshot.activeIndex]).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      status: "current",
    });
  });

  it.each([
    {
      name: "access-only generic alias",
      environment: { AWS_ACCESS_KEY_ID: "aws-access" },
      auth:
        "AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY missing",
      credentialSource:
        'Provider switch to "amazon-bedrock" blocked: set AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY.',
    },
    {
      name: "secret-only Bedrock alias",
      environment: {
        AWS_BEDROCK_SECRET_ACCESS_KEY: "aws-secret",
      },
      auth: "AWS_BEDROCK_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID missing",
      credentialSource:
        'Provider switch to "amazon-bedrock" blocked: set AWS_BEDROCK_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID.',
    },
  ])(
    "projects partial Bedrock credential state for $name",
    ({ environment, auth, credentialSource }) => {
      expect(bedrockProviderMenuRow(environment)).toMatchObject({
        runtimeState: "unauthenticated",
        authState: "missing",
        auth,
        credentialSource,
      });
    },
  );

  it("marks Bedrock ready with its complete primary credential aliases", () => {
    expect(
      bedrockProviderMenuRow({
        AWS_BEDROCK_ACCESS_KEY_ID: "aws-access",
        AWS_BEDROCK_SECRET_ACCESS_KEY: "aws-secret",
        AWS_BEDROCK_SESSION_TOKEN: "aws-session",
        AWS_BEDROCK_REGION: "ca-central-1",
      }),
    ).toMatchObject({
      runtimeState: "available",
      authState: "ready",
      auth: "AWS SigV4 environment",
      baseURL: "https://bedrock-runtime.ca-central-1.amazonaws.com",
      credentialSource:
        "env AWS_BEDROCK_ACCESS_KEY_ID + AWS_BEDROCK_SECRET_ACCESS_KEY + AWS_BEDROCK_SESSION_TOKEN + AWS_BEDROCK_REGION",
    });
  });

  it("uses the canonical endpoint alias in the provider menu", () => {
    expect(
      bedrockProviderMenuRow({
        AWS_BEDROCK_ACCESS_KEY_ID: "aws-access",
        AWS_BEDROCK_SECRET_ACCESS_KEY: "aws-secret",
        AWS_BEDROCK_REGION: "ca-central-1",
        AWS_BEDROCK_BASE_URL: "https://bedrock-proxy.example/v1",
      }),
    ).toMatchObject({
      baseURL: "https://bedrock-proxy.example/v1",
    });
  });

  it("projects stored Grok OAuth as a redacted native sign-in", () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-provider-oauth-"));
    const environment: EnvSnapshot = Object.freeze({
      XAI_API_KEY: "stale-xai-key",
      GROK_API_KEY: "stale-grok-key",
    });
    const home = resolveHomeContext(
      { AGENC_HOME: agencHome },
      { platformHome: tmpdir() },
    );
    try {
      expect(
        saveXaiOauthCredentials(home, {
          accessToken: "current-oauth-token",
          expiresAt: Date.now() + 60_000,
          accountLabel: "operator@example.com",
        }).success,
      ).toBe(true);
      const snapshot = readProviderMenuSnapshot(
        mkctx(
          stubSession({
            configStore: commandConfigStore(home),
            environment,
          }),
        ),
      );
      expect(
        snapshot.rows.find((row) => row.provider === "grok"),
      ).toMatchObject({
        authState: "ready",
        auth: "xAI OAuth",
        credentialSource: "native sign-in",
      });
      expect(JSON.stringify(snapshot)).not.toContain("current-oauth-token");
      expect(JSON.stringify(snapshot)).not.toContain("operator@example.com");
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  it("uses the ConfigStore home for a Grok OAuth provider switch", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-provider-xai-oauth-"));
    const home = resolveHomeContext(
      { AGENC_HOME: agencHome },
      { platformHome: tmpdir() },
    );
    try {
      expect(
        saveXaiOauthCredentials(home, {
          accessToken: "provider-command-oauth-token",
          expiresAt: Date.now() + 60_000,
        }).success,
      ).toBe(true);
      const session = stubSession({
        provider: "ollama",
        model: "llama3.3",
        configStore: commandConfigStore(home, {
          auth: { managedKeys: { enabled: true } },
        }),
        environment: Object.freeze({}),
      });

      const result = await providerCommand.execute(
        mkctx(session, "grok grok-4.6"),
      );

      expect(result).toEqual({
        kind: "text",
        text: expect.stringContaining('Provider switched to "grok"'),
      });
      expect(
        (session as unknown as { pendingProviderSwitch: unknown })
          .pendingProviderSwitch,
      ).toEqual({ provider: "grok", model: "grok-4.6" });
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  it("shows the canonical forced Gemini access-token and ADC sources", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-provider-menu-gemini-"));
    const adcPath = join(root, "application-default.json");
    writeFileSync(adcPath, "{}", { mode: 0o600 });
    const home = resolveHomeContext(
      { AGENC_HOME: join(root, "home") },
      { platformHome: root },
    );
    const row = (environment: EnvSnapshot) => {
      const snapshot = readProviderMenuSnapshot(
        mkctx(
          stubSession({
            configStore: commandConfigStore(home),
            environment,
          }),
        ),
      );
      return snapshot.rows.find((candidate) => candidate.provider === "gemini");
    };
    try {
      expect(row(Object.freeze({
        AGENC_HOME: home.path,
        GEMINI_AUTH_MODE: "access-token",
        GEMINI_ACCESS_TOKEN: "access-token",
        GEMINI_API_KEY: "must-not-win",
        GEMINI_PROJECT_ID: "authority-project",
        GEMINI_VERTEX_LOCATION: "us-central1",
      }))).toMatchObject({
        runtimeState: "available",
        authState: "ready",
        auth: "GEMINI_ACCESS_TOKEN",
        credentialSource: "env GEMINI_ACCESS_TOKEN",
        baseURL:
          "https://us-central1-aiplatform.googleapis.com/v1/projects/authority-project/locations/us-central1/publishers/google",
      });
      expect(row(Object.freeze({
        AGENC_HOME: home.path,
        GEMINI_AUTH_MODE: "adc",
        GOOGLE_APPLICATION_CREDENTIALS: adcPath,
        GOOGLE_API_KEY: "must-not-win",
        GEMINI_PROJECT_ID: "authority-project",
        GEMINI_VERTEX_LOCATION: "global",
      }))).toMatchObject({
        runtimeState: "available",
        authState: "ready",
        auth: "GOOGLE_APPLICATION_CREDENTIALS",
        credentialSource: "env GOOGLE_APPLICATION_CREDENTIALS",
        baseURL:
          "https://aiplatform.googleapis.com/v1/projects/authority-project/locations/global/publishers/google",
      });
      expect(row(Object.freeze({
        AGENC_HOME: home.path,
        GEMINI_AUTH_MODE: "access-token",
        GEMINI_API_KEY: "must-not-fallback",
        GEMINI_PROJECT_ID: "authority-project",
        GEMINI_VERTEX_LOCATION: "us-central1",
      }))).toMatchObject({
        runtimeState: "unauthenticated",
        authState: "missing",
        auth: "GEMINI_ACCESS_TOKEN missing",
        credentialSource:
          'Provider switch to "gemini" blocked: set GEMINI_ACCESS_TOKEN.',
      });
      expect(row(Object.freeze({
        AGENC_HOME: home.path,
        GEMINI_AUTH_MODE: "access-token",
        GEMINI_ACCESS_TOKEN: "access-token-without-target",
      }))).toMatchObject({
        runtimeState: "error",
        authState: "missing",
        detail: expect.stringContaining("requires both project and location"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows saved Gemini BYOK from the existing native secure storage", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-provider-menu-byok-"));
    const environment: EnvSnapshot = Object.freeze({
      AGENC_HOME: agencHome,
      GEMINI_AUTH_MODE: "api-key",
    });
    const home = resolveHomeContext(environment, { platformHome: tmpdir() });
    try {
      await new LocalAuthBackend({ agencHome, env: environment }).saveByokKey({
        provider: "gemini",
        apiKey: "saved-gemini-key",
      });
      const snapshot = readProviderMenuSnapshot(
        mkctx(
          stubSession({
            configStore: commandConfigStore(home),
            environment,
          }),
        ),
      );

      expect(snapshot.rows.find((row) => row.provider === "gemini")).toMatchObject({
        authState: "ready",
        auth: "saved Gemini BYOK",
        credentialSource: "native secure storage",
      });
      expect(JSON.stringify(snapshot)).not.toContain("saved-gemini-key");
    } finally {
      rmSync(agencHome, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "Bedrock access and generic secret aliases",
      environment: {
        AWS_BEDROCK_ACCESS_KEY_ID: "aws-access",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
      credentialSource:
        "env AWS_BEDROCK_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
    },
    {
      name: "generic access and Bedrock secret aliases",
      environment: {
        AWS_ACCESS_KEY_ID: "aws-access",
        AWS_BEDROCK_SECRET_ACCESS_KEY: "aws-secret",
      },
      credentialSource:
        "env AWS_ACCESS_KEY_ID + AWS_BEDROCK_SECRET_ACCESS_KEY",
    },
    {
      name: "generic aliases",
      environment: {
        AWS_ACCESS_KEY_ID: "aws-access",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
      credentialSource: "env AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
    },
  ])(
    "projects canonical Bedrock authority with $name",
    ({ environment, credentialSource }) => {
      expect(bedrockProviderMenuRow(environment)).toMatchObject({
        runtimeState: "available",
        authState: "ready",
        auth: "AWS SigV4 environment",
        credentialSource,
      });
    },
  );

  it("shows subscription-managed auth when managed keys are enabled and BYOK is absent", async () => {
    await withProAuthSession(({ configStore, environment }) => {
      const snapshot = readProviderMenuSnapshot(
        mkctx(
          stubSession({
            provider: "openrouter",
            model: "x-ai/grok-4.3",
            configStore,
            environment,
          }),
          "",
        ),
      );
      const openrouter = snapshot.rows.find(
        (row) => row.provider === "openrouter",
      );

      expect(openrouter).toMatchObject({
        authState: "managed",
        auth: "subscription",
      });
      expect(openrouter?.models.slice(0, 20)).toEqual([
        "x-ai/grok-4.5",
        "x-ai/grok-4.3",
        "x-ai/grok-build-0.1",
        "openai/gpt-4o-mini",
        "openai/gpt-5-nano",
        "openai/gpt-4.1-nano",
        "openai/gpt-oss-120b",
        "anthropic/claude-haiku-4.5",
        "google/gemini-2.5-flash",
        "google/gemini-2.5-flash-lite",
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v3.2",
        "qwen/qwen3-coder-30b-a3b-instruct",
        "qwen/qwen3-235b-a22b-2507",
        "mistralai/mistral-small-3.2-24b-instruct",
        "meta-llama/llama-3.3-70b-instruct",
        "meta-llama/llama-4-scout",
        "minimax/minimax-m2.5",
        "z-ai/glm-4.7-flash",
        "cohere/north-mini-code:free",
      ]);
      expect(openrouter?.models).not.toContain("openrouter/free");
      expect(openrouter?.models).toContain("openai/gpt-oss-20b:free");
      expect(openrouter?.models.length).toBeGreaterThan(20);
      expect(openrouter?.credentialSource).toBe(
        "authenticated AgenC account",
      );
    });
  });

  it("keeps the current provider selected for paid managed sessions", async () => {
    await withProAuthSession(({ configStore, environment }) => {
      const snapshot = readProviderMenuSnapshot(
        mkctx(
          stubSession({
            provider: "grok",
            model: "grok-4.3",
            configStore,
            environment,
          }),
          "",
        ),
      );

      expect(snapshot.rows[0]).toMatchObject({
        provider: "grok",
        model: "grok-4.3",
        status: "current",
      });
      expect(snapshot.rows[snapshot.activeIndex]?.provider).toBe("grok");
      expect(snapshot.currentProvider).toBe("grok");
      expect(snapshot.rows.find((row) => row.provider === "openrouter")).toMatchObject({
        authState: "managed",
        auth: "subscription",
        model: "x-ai/grok-4.5",
      });
    });
  });

  it("keeps the free managed route as explicit policy over provider defaults", async () => {
    await withAuthSession("free", async ({ configStore, environment }) => {
      const session = stubSession({
        provider: "grok",
        model: "grok-4.3",
        configStore,
        environment,
      });
      const managedDefault = subscriptionManagedDefaultModelForTier(
        "openrouter",
        "free",
      );
      if (managedDefault === undefined) {
        throw new Error("OpenRouter free managed default is missing");
      }

      await providerCommand.execute(mkctx(session, "openrouter"));

      expect(
        (session as unknown as { pendingProviderSwitch: unknown })
          .pendingProviderSwitch,
      ).toEqual({ provider: "openrouter", model: managedDefault });
      expect(managedDefault).not.toBe("x-ai/grok-4.5");
    });
  });

  it("keeps menu and direct selection on BYOK config during a managed session", async () => {
    await withProAuthSession(async ({ configStore, environment }) => {
      const byokEnvironment = Object.freeze({
        ...environment,
        OPENROUTER_API_KEY: "openrouter-test-key",
      });
      const byokStore = commandConfigStore(configStore.homeContext, {
        auth: { managedKeys: { enabled: true } },
        model_provider: "openrouter",
        model: "private-openrouter-model",
      });
      const session = stubSession({
        provider: "grok",
        model: "grok-4.3",
        configStore: byokStore,
        environment: byokEnvironment,
      });
      const snapshot = readProviderMenuSnapshot(mkctx(session));
      const openrouter = snapshot.rows.find(
        (row) => row.provider === "openrouter",
      );

      await providerCommand.execute(mkctx(session, "openrouter"));

      expect(openrouter).toMatchObject({
        authState: "ready",
        model: "private-openrouter-model",
      });
      expect(
        (session as unknown as { pendingProviderSwitch: unknown })
          .pendingProviderSwitch,
      ).toEqual({
        provider: "openrouter",
        model: "private-openrouter-model",
      });
    });
  });

  it("does not mark providers without live managed routes as subscription-managed", () => {
    const configStore = commandConfigStore(TEST_HOME, {
      auth: { managedKeys: { enabled: true } },
    });
    const snapshot = readProviderMenuSnapshot(
      mkctx(
        stubSession({
          provider: "grok",
          model: "grok-4.3",
          configStore,
        }),
        "",
      ),
    );
    const openai = snapshot.rows.find((row) => row.provider === "openai");

    expect(openai).toMatchObject({
      authState: "missing",
    });
    expect(openai?.auth).toContain("OPENAI_API_KEY");
    expect(openai?.credentialSource).toContain("OPENAI_API_KEY");
    expect(openai?.credentialSource).not.toContain("subscription-managed key");
  });

  it("shows the required AgenC sign-in action instead of optional provider auth", () => {
    const snapshot = readProviderMenuSnapshot(
      mkctx(
        stubSession({
          provider: "grok",
          model: "grok-4.3",
          configStore: commandConfigStore(TEST_HOME),
        }),
      ),
    );
    const agenc = snapshot.rows.find((row) => row.provider === "agenc");

    expect(agenc).toMatchObject({
      runtimeState: "unauthenticated",
      authState: "missing",
      auth: "AgenC sign-in required",
      credentialSource:
        'Provider switch to "agenc" blocked: sign in with AgenC using /login.',
    });
  });

  it("labels daemon-admitted credential checks as unverified", () => {
    const snapshot = readProviderMenuSnapshot(
      mkctx(
        stubSession({
          provider: "grok",
          model: "grok-4.3",
          configStore: commandConfigStore(TEST_HOME),
        }),
      ),
    );
    const openai = snapshot.rows.find((row) => row.provider === "openai");

    expect(openai).toMatchObject({
      runtimeState: "unverified",
      authState: "missing",
      detail: "credential checked on switch",
    });
  });

  it("marks local providers as local-only under managed subscription mode", () => {
    const configStore = commandConfigStore(TEST_HOME, {
      auth: { managedKeys: { enabled: true } },
    });
    const snapshot = readProviderMenuSnapshot(
      mkctx(
        stubSession({
          provider: "grok",
          model: "grok-4.3",
          configStore,
        }),
        "",
      ),
    );
    const lmstudio = snapshot.rows.find((row) => row.provider === "lmstudio");

    expect(lmstudio).toMatchObject({
      runtimeState: "local",
      authState: "optional",
      auth: "LMSTUDIO_API_KEY optional",
      detail: "local endpoint",
    });
    expect(lmstudio?.credentialSource).toBe("no provider key required");
  });

  it("does not block direct switches to local providers under managed subscription mode", async () => {
    const configStore = commandConfigStore(TEST_HOME, {
      auth: { managedKeys: { enabled: true } },
    });
    const session = stubSession({
      provider: "grok",
      model: "grok-4.3",
      configStore,
    });
    const res = await providerCommand.execute(mkctx(session, "lmstudio"));

    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toContain('Provider switched to "lmstudio"');
      expect(res.text).not.toContain("subscription-managed access");
    }
    const pending = (
      session as unknown as {
        pendingProviderSwitch: { provider: string; model: string } | null;
      }
    ).pendingProviderSwitch;
    expect(pending).toEqual({ provider: "lmstudio", model: "gpt-4o-mini" });
  });

  it("blocks direct provider switches to providers without subscription-managed routes or BYOK", async () => {
    const configStore = commandConfigStore(TEST_HOME, {
      auth: { managedKeys: { enabled: true } },
    });
    const res = await providerCommand.execute(
      mkctx(
        stubSession({
          provider: "grok",
          model: "grok-4.3",
          configStore,
        }),
        "openai",
      ),
    );

    expect(res).toEqual({
      kind: "text",
      text: expect.stringContaining(
        "hosted subscription access is available through OpenRouter",
      ),
    });
  });

  it.each([
    {
      name: "no credentials",
      environment: {},
      missing:
        "AWS_BEDROCK_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID and AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
    },
    {
      name: "access only",
      environment: { AWS_ACCESS_KEY_ID: "access" },
      missing: "AWS_BEDROCK_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY",
    },
    {
      name: "secret only",
      environment: { AWS_BEDROCK_SECRET_ACCESS_KEY: "secret" },
      missing: "AWS_BEDROCK_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID",
    },
  ])(
    "blocks a direct Bedrock provider switch with $name",
    async ({ environment, missing }) => {
      const configStore = commandConfigStore(TEST_HOME, {
        auth: { managedKeys: { enabled: true } },
      });
      const session = stubSession({
        provider: "grok",
        model: "grok-4.3",
        configStore,
        environment: Object.freeze({ ...TEST_ENVIRONMENT, ...environment }),
      });

      const result = await providerCommand.execute(
        mkctx(session, "amazon-bedrock"),
      );

      expect(result).toEqual({
        kind: "text",
        text: expect.stringContaining(`set ${missing}`),
      });
      expect(
        (session as unknown as { pendingProviderSwitch: unknown })
          .pendingProviderSwitch,
      ).toBeNull();
    },
  );

  it.each([
    {
      name: "primary aliases",
      environment: {
        AWS_BEDROCK_ACCESS_KEY_ID: "access",
        AWS_BEDROCK_SECRET_ACCESS_KEY: "secret",
      },
    },
    {
      name: "mixed aliases",
      environment: {
        AWS_ACCESS_KEY_ID: "access",
        AWS_BEDROCK_SECRET_ACCESS_KEY: "secret",
      },
    },
  ])(
    "allows a direct Bedrock provider switch with complete $name",
    async ({ environment }) => {
      const configStore = commandConfigStore(TEST_HOME, {
        auth: { managedKeys: { enabled: true } },
      });
      const session = stubSession({
        provider: "grok",
        model: "grok-4.3",
        configStore,
        environment: Object.freeze({ ...TEST_ENVIRONMENT, ...environment }),
      });

      const result = await providerCommand.execute(
        mkctx(session, "amazon-bedrock"),
      );

      expect(result).toEqual({
        kind: "text",
        text: expect.stringContaining('Provider switched to "amazon-bedrock"'),
      });
      expect(
        (session as unknown as { pendingProviderSwitch: unknown })
          .pendingProviderSwitch,
      ).toMatchObject({ provider: "amazon-bedrock" });
    },
  );
});
