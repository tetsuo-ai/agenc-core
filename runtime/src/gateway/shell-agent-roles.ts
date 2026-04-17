import type { ToolCatalogEntry } from "../tools/types.js";
import type { AgentDefinition } from "./agent-loader.js";
import {
  getShellProfilePreferredToolNames,
  type SessionShellProfile,
} from "./shell-profile.js";

export type ShellAgentRoleSource = "curated" | "built-in" | "project" | "user";

export type ShellAgentTrustLabel =
  | "runtime"
  | "project-local"
  | "user-local";

export type ShellAgentToolBundleName =
  | "inherit"
  | "coding-core"
  | "docs-core"
  | "research-evidence"
  | "verification-probes"
  | "operator-core"
  | "marketplace-core"
  | "browser-test"
  | "remote-debug";

export interface ShellAgentRoleDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly source: ShellAgentRoleSource;
  readonly trustLabel: ShellAgentTrustLabel;
  readonly curated: boolean;
  readonly definitionName?: string;
  readonly defaultShellProfile: SessionShellProfile;
  readonly defaultToolBundle: ShellAgentToolBundleName;
  readonly mutating: boolean;
  readonly worktreeEligible: boolean;
}

interface CuratedShellAgentRoleDefinition {
  readonly descriptor: ShellAgentRoleDescriptor;
  readonly systemPrompt: string;
}

export interface ResolvedShellAgentRole {
  readonly descriptor: ShellAgentRoleDescriptor;
  readonly systemPrompt?: string;
  readonly toolNames?: readonly string[];
  readonly shellProfile: SessionShellProfile;
  readonly toolBundle: ShellAgentToolBundleName;
}

const VERIFY_SYSTEM_PROMPT = `You are a verification specialist. Your job is not to confirm the implementation works — it's to try to break it.

You have two documented failure patterns. First, verification avoidance: when faced with a check, you find reasons not to run it — you read code, narrate what you would test, write "PASS," and move on. Second, being seduced by the first 80%: you see a polished UI or a passing test suite and feel inclined to pass it, not noticing half the buttons do nothing, the state vanishes on refresh, or the backend crashes on bad input. The first 80% is the easy part. Your entire value is in finding the last 20%. The caller may spot-check your commands by re-running them — if a PASS step has no command output, or output that doesn't match re-execution, your report gets rejected.

=== CRITICAL: DO NOT MODIFY THE PROJECT ===
You are STRICTLY PROHIBITED from:
- Creating, modifying, or deleting any files IN THE PROJECT DIRECTORY
- Installing dependencies or packages
- Running git write operations (add, commit, push)

You MAY write ephemeral test scripts to a temp directory (/tmp or $TMPDIR) via system.bash redirection when inline commands aren't sufficient — e.g., a multi-step race harness or a Playwright test. Clean up after yourself.

Check your ACTUAL available tools rather than assuming from this prompt. You may have browser automation (mcp.browser.*, playwright.*), system.httpFetch, or other tools depending on the session — do not skip capabilities you didn't think to check for.

=== WHAT YOU RECEIVE ===
You will receive: the original task description, files changed, approach taken, and optionally a plan file path.

=== VERIFICATION STRATEGY ===
Adapt your strategy based on what was changed:

**Frontend changes**: Start dev server → check your tools for browser automation (mcp.browser.*, playwright.*) and USE them to navigate, screenshot, click, and read console — do NOT say "needs a real browser" without attempting → curl a sample of page subresources (image-optimizer URLs, same-origin API routes, static assets) since HTML can serve 200 while everything it references fails → run frontend tests
**Backend/API changes**: Start server → curl/fetch endpoints → verify response shapes against expected values (not just status codes) → test error handling → check edge cases
**CLI/script changes**: Run with representative inputs → verify stdout/stderr/exit codes → test edge inputs (empty, malformed, boundary) → verify --help / usage output is accurate
**Infrastructure/config changes**: Validate syntax → dry-run where possible (terraform plan, kubectl apply --dry-run=server, docker build, nginx -t) → check env vars / secrets are actually referenced, not just defined
**Library/package changes**: Build → full test suite → import the library from a fresh context and exercise the public API as a consumer would → verify exported types match README/docs examples
**Bug fixes**: Reproduce the original bug → verify fix → run regression tests → check related functionality for side effects
**Data/ML pipeline**: Run with sample input → verify output shape/schema/types → test empty input, single row, NaN/null handling → check for silent data loss (row counts in vs out)
**Database migrations**: Run migration up → verify schema matches intent → run migration down (reversibility) → test against existing data, not just empty DB
**Refactoring (no behavior change)**: Existing test suite MUST pass unchanged → diff the public API surface (no new/removed exports) → spot-check observable behavior is identical (same inputs → same outputs)
**Other change types**: The pattern is always the same — (a) figure out how to exercise this change directly (run/call/invoke/deploy it), (b) check outputs against expectations, (c) try to break it with inputs/conditions the implementer didn't test.

=== REQUIRED STEPS (universal baseline) ===
1. Read the project's AGENT.md / AGENC.md / README for build/test commands and conventions. Check package.json / Makefile / pyproject.toml / CMakeLists.txt for script and build names. If the implementer pointed you to a plan or spec file, read it — that's the success criteria.
2. Run the build (if applicable). A broken build is an automatic FAIL.
3. Run the project's test suite (if it has one). Failing tests are an automatic FAIL.
4. Run linters/type-checkers if configured (eslint, tsc, mypy, etc.).
5. Check for regressions in related code.

Then apply the type-specific strategy above. Match rigor to stakes: a one-off script doesn't need race-condition probes; production code needs everything.

Test suite results are context, not evidence. Run the suite, note pass/fail, then move on to your real verification. The implementer is an LLM too — its tests may be heavy on mocks, circular assertions, or happy-path coverage that proves nothing about whether the system actually works end-to-end.

=== RECOGNIZE YOUR OWN RATIONALIZATIONS ===
You will feel the urge to skip checks. These are the exact excuses you reach for — recognize them and do the opposite:
- "The code looks correct based on my reading" — reading is not verification. Run it.
- "The implementer's tests already pass" — the implementer is an LLM. Verify independently.
- "This is probably fine" — probably is not verified. Run it.
- "Let me start the server and check the code" — no. Start the server and hit the endpoint.
- "I don't have a browser" — did you actually check for mcp.browser.* / playwright.*? If present, use them. If a tool fails, troubleshoot (server running? selector right?). The fallback exists so you don't invent your own "can't do this" story.
- "This would take too long" — not your call.
If you catch yourself writing an explanation instead of a command, stop. Run the command.

=== ADVERSARIAL PROBES (adapt to the change type) ===
Functional tests confirm the happy path. Also try to break it:
- **Concurrency** (servers/APIs): parallel requests to create-if-not-exists paths — duplicate sessions? lost writes?
- **Boundary values**: 0, -1, empty string, very long strings, unicode, MAX_INT
- **Idempotency**: same mutating request twice — duplicate created? error? correct no-op?
- **Orphan operations**: delete/reference IDs that don't exist
These are seeds, not a checklist — pick the ones that fit what you're verifying.

=== BEFORE ISSUING PASS ===
Your report must include at least one adversarial probe you ran (concurrency, boundary, idempotency, orphan op, or similar) and its result — even if the result was "handled correctly." If all your checks are "returns 200" or "test suite passes," you have confirmed the happy path, not verified correctness. Go back and try to break something.

=== BEFORE ISSUING FAIL ===
You found something that looks broken. Before reporting FAIL, check you haven't missed why it's actually fine:
- **Already handled**: is there defensive code elsewhere (validation upstream, error recovery downstream) that prevents this?
- **Intentional**: does AGENT.md / AGENC.md / comments / commit message explain this as deliberate?
- **Not actionable**: is this a real limitation but unfixable without breaking an external contract (stable API, protocol spec, backwards compat)? If so, note it as an observation, not a FAIL — a "bug" that can't be fixed isn't actionable.
Don't use these as excuses to wave away real issues — but don't FAIL on intentional behavior either.

=== OUTPUT FORMAT (REQUIRED) ===
Every check MUST follow this structure. A check without a Command run block is not a PASS — it's a skip.

\`\`\`
### Check: [what you're verifying]
**Command run:**
  [exact command you executed]
**Output observed:**
  [actual terminal output — copy-paste, not paraphrased. Truncate if very long but keep the relevant part.]
**Result: PASS** (or FAIL — with Expected vs Actual)
\`\`\`

Bad (rejected):
\`\`\`
### Check: POST /api/register validation
**Result: PASS**
Evidence: Reviewed the route handler. The logic correctly validates
email format and password length before DB insert.
\`\`\`
(No command run. Reading code is not verification.)

Good:
\`\`\`
### Check: POST /api/register rejects short password
**Command run:**
  curl -s -X POST localhost:8000/api/register -H 'Content-Type: application/json' \\
    -d '{"email":"t@t.co","password":"short"}' | python3 -m json.tool
**Output observed:**
  {
    "error": "password must be at least 8 characters"
  }
  (HTTP 400)
**Expected vs Actual:** Expected 400 with password-length error. Got exactly that.
**Result: PASS**
\`\`\`

End with exactly this line (parsed by caller):

VERDICT: PASS
or
VERDICT: FAIL
or
VERDICT: PARTIAL

PARTIAL is for environmental limitations only (no test framework, tool unavailable, server can't start) — not for "I'm unsure whether this is a bug." If you can run the check, you must decide PASS or FAIL.

Use the literal string \`VERDICT: \` followed by exactly one of \`PASS\`, \`FAIL\`, \`PARTIAL\`. No markdown bold, no punctuation, no variation.
- **FAIL**: include what failed, exact error output, reproduction steps.
- **PARTIAL**: what was verified, what could not be and why (missing tool/env), what the implementer should know.`;

const CURATED_ROLE_DEFINITIONS: readonly CuratedShellAgentRoleDefinition[] = [
  {
    descriptor: {
      id: "coding",
      displayName: "Coding",
      description: "Bounded implementation child for repo-local code changes.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "coding",
      defaultToolBundle: "coding-core",
      mutating: true,
      worktreeEligible: true,
    },
    systemPrompt:
      "You are a coding child agent. Execute one bounded implementation objective inside the assigned workspace scope. " +
      "Prefer inspect-edit-verify loops, stay within the declared file and tool scope, and report concrete outputs instead of narrating every step.",
  },
  {
    descriptor: {
      id: "docs",
      displayName: "Docs",
      description: "Documentation and examples child for concise user-facing edits.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "documentation",
      defaultToolBundle: "docs-core",
      mutating: true,
      worktreeEligible: true,
    },
    systemPrompt:
      "You are a documentation child agent. Focus on docs, examples, onboarding text, and explanation-oriented file edits. " +
      "Keep wording precise, verify referenced commands or paths when they matter, and avoid widening scope into unrelated product work.",
  },
  {
    descriptor: {
      id: "research",
      displayName: "Research",
      description: "Read-only evidence-gathering child for source-backed investigation.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "research",
      defaultToolBundle: "research-evidence",
      mutating: false,
      worktreeEligible: false,
    },
    systemPrompt:
      "You are a research child agent. Gather evidence from code, docs, browser, and structured runtime surfaces before concluding. " +
      "Do not mutate project files unless the parent explicitly widens your scope.",
  },
  {
    descriptor: {
      id: "verify",
      displayName: "Verify",
      description: "Verifier child that tries to disprove an implementation with concrete checks.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "validation",
      defaultToolBundle: "verification-probes",
      mutating: false,
      worktreeEligible: false,
    },
    systemPrompt: VERIFY_SYSTEM_PROMPT,
  },
  {
    descriptor: {
      id: "operator",
      displayName: "Operator",
      description: "Runtime operations child for daemon, approvals, MCP, plugin, and session workflows.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "operator",
      defaultToolBundle: "operator-core",
      mutating: false,
      worktreeEligible: false,
    },
    systemPrompt:
      "You are an operator child agent. Focus on runtime control-plane tasks such as sessions, approvals, MCP, plugins, connectors, and daemon health. " +
      "Prefer structured runtime surfaces over ad hoc shell commands when both can solve the task.",
  },
  {
    descriptor: {
      id: "marketplace",
      displayName: "Marketplace",
      description: "Marketplace/operator child for protocol task, skill, reputation, and governance surfaces.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "operator",
      defaultToolBundle: "marketplace-core",
      mutating: false,
      worktreeEligible: false,
    },
    systemPrompt:
      "You are a marketplace child agent. Focus on AgenC marketplace, reputation, dispute, and governance surfaces. " +
      "Use the structured market and operator tool surfaces instead of broad repo edits unless the parent explicitly assigns them.",
  },
  {
    descriptor: {
      id: "browser-testing",
      displayName: "Browser Testing",
      description: "Browser-grounded QA child for UI and flow validation.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "validation",
      defaultToolBundle: "browser-test",
      mutating: false,
      worktreeEligible: false,
    },
    systemPrompt:
      "You are a browser-testing child agent. Validate UI and workflow behavior with browser-grounded inspection and repo context. " +
      "Collect findings and evidence; do not mutate project files unless the parent explicitly assigns a fix phase.",
  },
  {
    descriptor: {
      id: "remote-debugging",
      displayName: "Remote Debugging",
      description: "Remote session and job debugging child for bounded operational diagnosis.",
      source: "curated",
      trustLabel: "runtime",
      curated: true,
      defaultShellProfile: "validation",
      defaultToolBundle: "remote-debug",
      mutating: false,
      worktreeEligible: false,
    },
    systemPrompt:
      "You are a remote-debugging child agent. Investigate remote sessions, jobs, logs, and linked repo context to isolate concrete failures. " +
      "Bias toward evidence collection and diagnosis over speculative fixes.",
  },
] as const;

function titleCaseToken(value: string): string {
  return value
    .split(/[-_:\s]+/u)
    .filter((entry) => entry.length > 0)
    .map((entry) => entry[0]!.toUpperCase() + entry.slice(1))
    .join(" ");
}

function inferShellProfileFromDefinition(
  definition: AgentDefinition,
): SessionShellProfile {
  const corpus = `${definition.name} ${definition.description} ${definition.tools.join(" ")}`.toLowerCase();
  if (/\bverify|verification|probe\b/.test(corpus)) {
    return "validation";
  }
  if (/\boperator|daemon|approval|connector|mcp|marketplace|wallet|social\b/.test(corpus)) {
    return "operator";
  }
  if (/\bdoc|readme|example|guide|onboard\b/.test(corpus)) {
    return "documentation";
  }
  if (/\bresearch|explore|browse|source|evidence\b/.test(corpus)) {
    return "research";
  }
  if (/\bwritefile|appendfile|editfile|applypatch|bash\b/.test(corpus)) {
    return "coding";
  }
  return "general";
}

function inferToolBundleFromDefinition(
  definition: AgentDefinition,
): ShellAgentToolBundleName {
  const corpus = `${definition.name} ${definition.description} ${definition.tools.join(" ")}`.toLowerCase();
  if (/\bverify|verification|probe\b/.test(corpus)) {
    return "verification-probes";
  }
  if (/\boperator|daemon|approval|connector|mcp\b/.test(corpus)) {
    return "operator-core";
  }
  if (/\bmarketplace|reputation|governance|dispute\b/.test(corpus)) {
    return "marketplace-core";
  }
  if (/\bplaywright|browser_\b|browser\b/.test(corpus)) {
    return "browser-test";
  }
  if (/\bremotejob|remotesession|remote\b/.test(corpus)) {
    return "remote-debug";
  }
  if (/\bdoc|readme|example|guide\b/.test(corpus)) {
    return "docs-core";
  }
  if (/\bresearch|explore|browse|evidence\b/.test(corpus)) {
    return "research-evidence";
  }
  if (/\bwritefile|appendfile|editfile|applypatch|bash\b/.test(corpus)) {
    return "coding-core";
  }
  return "inherit";
}

function toRoleSource(
  source: AgentDefinition["source"],
): Extract<ShellAgentRoleSource, "built-in" | "project" | "user"> {
  if (source === "project") return "project";
  if (source === "user") return "user";
  return "built-in";
}

function toTrustLabel(
  source: ShellAgentRoleSource,
): ShellAgentTrustLabel {
  if (source === "project") return "project-local";
  if (source === "user") return "user-local";
  return "runtime";
}

function toDefinitionRoleId(definition: AgentDefinition): string {
  if (definition.source === "project") {
    return `project:${definition.name}`;
  }
  if (definition.source === "user") {
    return `user:${definition.name}`;
  }
  return definition.name;
}

function includesPrefix(
  name: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some((prefix) => name === prefix || name.startsWith(prefix));
}

function collectNamedTools(
  availableToolNames: readonly string[],
  exactNames: readonly string[] = [],
  prefixes: readonly string[] = [],
): readonly string[] {
  return Array.from(
    new Set(
      availableToolNames.filter((toolName) =>
        exactNames.includes(toolName) || includesPrefix(toolName, prefixes)
      ),
    ),
  );
}

function resolveToolBundleToolNames(params: {
  readonly bundle: ShellAgentToolBundleName;
  readonly availableToolNames: readonly string[];
}): readonly string[] | undefined {
  const { bundle, availableToolNames } = params;
  if (bundle === "inherit") {
    return undefined;
  }
  if (bundle === "coding-core") {
    return getShellProfilePreferredToolNames({
      profile: "coding",
      availableToolNames,
    });
  }
  if (bundle === "docs-core") {
    return Array.from(
      new Set([
        ...getShellProfilePreferredToolNames({
          profile: "documentation",
          availableToolNames,
        }),
        ...collectNamedTools(availableToolNames, [
          "system.readFile",
          "system.writeFile",
          "system.appendFile",
          "system.editFile",
          "system.grep",
          "system.searchTools",
        ]),
      ]),
    );
  }
  if (bundle === "research-evidence") {
    return Array.from(
      new Set([
        ...getShellProfilePreferredToolNames({
          profile: "research",
          availableToolNames,
        }),
        ...collectNamedTools(availableToolNames, [
          "system.readFile",
          "system.listDir",
          "system.grep",
          "system.symbolSearch",
          "system.symbolDefinition",
          "system.symbolReferences",
          "system.searchTools",
        ]),
      ]),
    );
  }
  if (bundle === "verification-probes") {
    return collectNamedTools(
      availableToolNames,
      [
        "system.readFile",
        "system.listDir",
        "system.stat",
        "system.grep",
        "system.bash",
        "system.httpGet",
        "system.httpPost",
        "system.httpFetch",
        "system.browse",
        "task.list",
        "task.get",
        "system.searchTools",
      ],
      ["playwright.", "mcp.browser.", "system.browser"],
    );
  }
  if (bundle === "operator-core") {
    return getShellProfilePreferredToolNames({
      profile: "operator",
      availableToolNames,
    });
  }
  if (bundle === "marketplace-core") {
    return Array.from(
      new Set([
        ...getShellProfilePreferredToolNames({
          profile: "operator",
          availableToolNames,
        }),
        ...collectNamedTools(availableToolNames, [], ["agenc."]),
      ]),
    );
  }
  if (bundle === "browser-test") {
    return collectNamedTools(
      availableToolNames,
      [
        "system.readFile",
        "system.listDir",
        "system.grep",
        "system.searchTools",
      ],
      ["playwright.", "browser_"],
    );
  }
  if (bundle === "remote-debug") {
    return collectNamedTools(
      availableToolNames,
      [
        "system.readFile",
        "system.listDir",
        "system.grep",
        "system.searchTools",
      ],
      ["system.remoteJob", "system.remoteSession"],
    );
  }
  return undefined;
}

function intersectTools(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!left && !right) return undefined;
  if (!left) return right;
  if (!right) return left;
  const allowed = new Set(right);
  const intersection = left.filter((toolName) => allowed.has(toolName));
  return intersection.length > 0 ? intersection : [];
}

export function listCuratedShellAgentRoles(): readonly ShellAgentRoleDescriptor[] {
  return CURATED_ROLE_DEFINITIONS.map((entry) => entry.descriptor);
}

export function buildShellAgentRoleCatalog(params: {
  readonly definitions: readonly AgentDefinition[];
}): readonly ShellAgentRoleDescriptor[] {
  const curated = CURATED_ROLE_DEFINITIONS.map((entry) => entry.descriptor);
  const builtinDefinitions: ShellAgentRoleDescriptor[] = [];
  const projectDefinitions: ShellAgentRoleDescriptor[] = [];
  const userDefinitions: ShellAgentRoleDescriptor[] = [];

  for (const definition of params.definitions) {
    const source = toRoleSource(definition.source);
    const descriptor: ShellAgentRoleDescriptor = {
      id: toDefinitionRoleId(definition),
      displayName: titleCaseToken(definition.name),
      description: definition.description || `${titleCaseToken(definition.name)} agent`,
      source,
      trustLabel: toTrustLabel(source),
      curated: false,
      definitionName: definition.name,
      defaultShellProfile: inferShellProfileFromDefinition(definition),
      defaultToolBundle: inferToolBundleFromDefinition(definition),
      mutating: definition.tools.some((toolName) =>
        [
          "system.writeFile",
          "system.appendFile",
          "system.editFile",
          "desktop.text_editor",
          "desktop.bash",
          "system.bash",
        ].includes(toolName)
      ),
      worktreeEligible: definition.tools.some((toolName) =>
        [
          "system.writeFile",
          "system.appendFile",
          "system.editFile",
          "desktop.text_editor",
          "desktop.bash",
          "system.bash",
        ].includes(toolName)
      ),
    };
    if (source === "project") {
      projectDefinitions.push(descriptor);
    } else if (source === "user") {
      userDefinitions.push(descriptor);
    } else {
      builtinDefinitions.push(descriptor);
    }
  }

  return [...curated, ...builtinDefinitions, ...projectDefinitions, ...userDefinitions];
}

export function resolveShellAgentRole(params: {
  readonly roleId: string;
  readonly definitions: readonly AgentDefinition[];
  readonly toolCatalog: readonly ToolCatalogEntry[];
  readonly toolBundleOverride?: ShellAgentToolBundleName;
  readonly shellProfileOverride?: SessionShellProfile;
}): ResolvedShellAgentRole | undefined {
  const curated = CURATED_ROLE_DEFINITIONS.find(
    (entry) => entry.descriptor.id === params.roleId,
  );
  const availableToolNames = params.toolCatalog.map((entry) => entry.name);
  if (curated) {
    const toolBundle =
      params.toolBundleOverride ?? curated.descriptor.defaultToolBundle;
    return {
      descriptor: curated.descriptor,
      systemPrompt: curated.systemPrompt,
      shellProfile:
        params.shellProfileOverride ?? curated.descriptor.defaultShellProfile,
      toolBundle,
      toolNames: resolveToolBundleToolNames({
        bundle: toolBundle,
        availableToolNames,
      }),
    };
  }

  const definition = params.definitions.find(
    (entry) => toDefinitionRoleId(entry) === params.roleId,
  );
  if (!definition) {
    return undefined;
  }
  const source = toRoleSource(definition.source);
  const descriptor: ShellAgentRoleDescriptor = {
    id: toDefinitionRoleId(definition),
    displayName: titleCaseToken(definition.name),
    description: definition.description || `${titleCaseToken(definition.name)} agent`,
    source,
    trustLabel: toTrustLabel(source),
    curated: false,
    definitionName: definition.name,
    defaultShellProfile: inferShellProfileFromDefinition(definition),
    defaultToolBundle: inferToolBundleFromDefinition(definition),
    mutating: definition.tools.some((toolName) =>
      [
        "system.writeFile",
        "system.appendFile",
        "system.editFile",
        "desktop.text_editor",
        "desktop.bash",
        "system.bash",
      ].includes(toolName)
    ),
    worktreeEligible: definition.tools.some((toolName) =>
      [
        "system.writeFile",
        "system.appendFile",
        "system.editFile",
        "desktop.text_editor",
        "desktop.bash",
        "system.bash",
      ].includes(toolName)
    ),
  };
  const toolBundle =
    params.toolBundleOverride ?? descriptor.defaultToolBundle;
  const bundledToolNames = resolveToolBundleToolNames({
    bundle: toolBundle,
    availableToolNames,
  });
  const toolNames = definition.tools.length > 0
    ? intersectTools(
        definition.tools,
        bundledToolNames ?? definition.tools,
      )
    : bundledToolNames;
  return {
    descriptor,
    systemPrompt: definition.body.trim().length > 0 ? definition.body.trim() : undefined,
    shellProfile:
      params.shellProfileOverride ?? descriptor.defaultShellProfile,
    toolBundle,
    toolNames,
  };
}
