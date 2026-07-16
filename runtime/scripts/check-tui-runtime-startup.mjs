#!/usr/bin/env node
/**
 * Trusted built-artifact import and PTY startup smoke for the AgenC TUI.
 *
 * Candidate artifacts never execute in the success-deciding process. The
 * import probe runs in a permission-restricted child and must sign a fresh
 * parent challenge with a non-extractable key created before the import. A
 * candidate artifact that calls process.exit(0), disconnects IPC, or forges a
 * fixed success marker therefore fails closed.
 */
import { fork } from "node:child_process";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const TRUSTED_REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "../..");
const IMPORT_PROTOCOL = "agenc-tui-import-proof-v1";
const IMPORT_TIMEOUT_MS = 15_000;
const MAX_IMPORT_OUTPUT_BYTES = 64 * 1024;
const MAX_PTY_OUTPUT_BYTES = 1024 * 1024;
// A freshly rebuilt 10+ MiB runtime can take longer than 1.5s to produce its
// first PTY byte on a cold filesystem/module cache. Keep this below the import
// timeout, but leave enough headroom that the pre-commit build immediately
// followed by this smoke does not fail a healthy first viewport.
const FIRST_PAINT_MS = 3_000;
const POST_REPLY_MS = 1_500;
const SIGTERM_GRACE_MS = 1_000;
const FORCE_KILL_GRACE_MS = 1_000;
const MIN_SEMANTIC_PAINT_BYTES = 128;

function resolveRuntimeDirectory() {
  const configured = process.env.AGENC_TUI_SMOKE_RUNTIME_DIR;
  const candidate = configured === undefined || configured === ""
    ? path.resolve(SCRIPT_DIR, "..")
    : configured;
  if (!path.isAbsolute(candidate) || candidate.includes("\0") || /[\r\n]/u.test(candidate)) {
    throw new Error("TUI smoke runtime directory must be an absolute path");
  }
  const resolved = realpathSync(candidate);
  if (!lstatSync(resolved).isDirectory()) {
    throw new Error("TUI smoke runtime directory must be one real directory");
  }
  return resolved;
}

const RUNTIME_DIR = resolveRuntimeDirectory();
const CANDIDATE_REPOSITORY_ROOT = realpathSync(path.dirname(RUNTIME_DIR));
const DIST_ROOT_PATH = path.join(RUNTIME_DIR, "dist", "index.js");
const DIST_TUI_PATH = path.join(RUNTIME_DIR, "dist", "tui", "main.js");
const BIN_AGENC_PATH = path.join(RUNTIME_DIR, "dist", "bin", "agenc.js");
const requireFromRuntime = createRequire(path.join(RUNTIME_DIR, "package.json"));

const VIEWPORTS = Object.freeze([
  Object.freeze({ cols: 148, rows: 40 }),
  Object.freeze({ cols: 120, rows: 30 }),
  Object.freeze({ cols: 80, rows: 24 }),
]);
const XTVERSION_REPLY = "\x1b[>0;1;0c";
const DA1_REPLY = "\x1b[?6c";
const FATAL_PATTERNS = Object.freeze([
  /\bUncaught\s+(?:Exception|TypeError|ReferenceError|Error)\b/i,
  /Cannot find (?:module|package)\b/i,
  /\bUnhandled (?:promise rejection|rejection)\b/i,
  /\bTypeError:\s/,
  /\bReferenceError:\s/,
  /\bSyntaxError:\s/,
  /\bAssertionError:\s/,
  /\bERROR\s{2,}\S/,
  /\bat\s+(?:async\s+)?[\w$.<>[\]]+\s+\(?(?:file:|node:|\/)[^\s)]+:\d+:\d+\)?/,
]);

function red(text) {
  return process.stdout.isTTY ? `\x1b[31m${text}\x1b[0m` : text;
}

function green(text) {
  return process.stdout.isTTY ? `\x1b[32m${text}\x1b[0m` : text;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function regularFileSha256(filePath, containmentRoot) {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 512 * 1024 * 1024) {
    throw new Error(`TUI import artifact is not one bounded regular file: ${filePath}`);
  }
  const resolved = realpathSync(filePath);
  if (!isWithin(realpathSync(containmentRoot), resolved)) {
    throw new Error(`TUI import artifact escaped its repository: ${filePath}`);
  }
  return createHash("sha256").update(readFileSync(resolved)).digest("hex");
}

function canonicalBase64(value, label, maxBytes) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes * 2) {
    throw new Error(`${label} is invalid`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > maxBytes || decoded.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

function normalizeExportRequirements(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("import export requirements must be an object");
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (
    entries.length === 0 ||
    entries.some(([name, kind]) =>
      !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u.test(name) ||
      (kind !== "present" && kind !== "function")
    )
  ) {
    throw new Error("import export requirements are invalid");
  }
  return Object.freeze(Object.fromEntries(entries));
}

function importStatement(challenge, artifactSha256, requirementsJson) {
  return Buffer.from(
    `${IMPORT_PROTOCOL}\0${challenge.toString("base64")}\0${artifactSha256}\0${requirementsJson}`,
    "utf8",
  );
}

function sendIpc(send, frame) {
  return new Promise((resolve, reject) => {
    send(frame, (error) => error ? reject(error) : resolve());
  });
}

function receiveChallenge(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.off("message", onMessage);
      reject(new Error("import probe challenge timed out"));
    }, timeoutMs);
    const onMessage = (message) => {
      clearTimeout(timeout);
      process.off("message", onMessage);
      try {
        if (
          message === null ||
          typeof message !== "object" ||
          Array.isArray(message) ||
          JSON.stringify(Object.keys(message).sort()) !== JSON.stringify(["challenge", "type"]) ||
          message.type !== "challenge"
        ) {
          throw new Error("import probe received an invalid challenge frame");
        }
        resolve(canonicalBase64(message.challenge, "import challenge", 32));
      } catch (error) {
        reject(error);
      }
    };
    process.on("message", onMessage);
  });
}

async function importProbeChild(
  artifactPath,
  expectedSha256,
  containmentRoot,
  requirementsJson,
) {
  if (typeof process.send !== "function" || !process.connected) {
    throw new Error("import probe requires a private IPC channel");
  }
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256 ?? "")) {
    throw new Error("import probe received an invalid artifact digest");
  }
  let requirements;
  try {
    requirements = normalizeExportRequirements(JSON.parse(requirementsJson));
  } catch (error) {
    throw new Error("import probe received invalid export requirements", { cause: error });
  }
  if (JSON.stringify(requirements) !== requirementsJson) {
    throw new Error("import probe export requirements are not canonical");
  }
  const observed = regularFileSha256(artifactPath, containmentRoot);
  if (observed !== expectedSha256) throw new Error("import artifact changed before child execution");

  const send = process.send.bind(process);
  const subtle = webcrypto.subtle;
  const sign = subtle.sign.bind(subtle);
  const keyPair = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const publicSpki = Buffer.from(await subtle.exportKey("spki", keyPair.publicKey));
  await sendIpc(send, {
    type: "ready",
    protocol: IMPORT_PROTOCOL,
    publicKey: publicSpki.toString("base64"),
  });
  const challenge = await receiveChallenge(5_000);
  const statement = importStatement(challenge, expectedSha256, requirementsJson);
  // Capture the validated requirements before candidate code can replace
  // mutable globals such as Object.entries.
  const requiredExportEntries = Object.freeze(
    Object.entries(requirements).map(([name, kind]) => Object.freeze({ name, kind })),
  );

  const module = await import(`${pathToFileURL(artifactPath).href}?agenc-import-proof=${expectedSha256}`);
  for (let index = 0; index < requiredExportEntries.length; index += 1) {
    const name = requiredExportEntries[index].name;
    const kind = requiredExportEntries[index].kind;
    if (!(name in module) || (kind === "function" && typeof module[name] !== "function")) {
      throw new Error(`built artifact does not satisfy export ${name}:${kind}`);
    }
  }
  const signature = Buffer.from(await sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    statement,
  ));
  await sendIpc(send, {
    type: "proof",
    protocol: IMPORT_PROTOCOL,
    signature: signature.toString("base64"),
  });
}

function importChildEnvironment() {
  return {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TZ: "UTC",
  };
}

export async function runImportProbe({
  artifactPath = DIST_TUI_PATH,
  containmentRoot = CANDIDATE_REPOSITORY_ROOT,
  timeoutMs = IMPORT_TIMEOUT_MS,
  requiredExports = { bootTUI: "function" },
} = {}) {
  const expectedSha256 = regularFileSha256(artifactPath, containmentRoot);
  const requirementsJson = JSON.stringify(normalizeExportRequirements(requiredExports));
  const challenge = randomBytes(32);
  const allowedRoots = [...new Set([
    realpathSync(TRUSTED_REPOSITORY_ROOT),
    realpathSync(containmentRoot),
  ])];
  const child = fork(
    SCRIPT_PATH,
    [
      "--import-probe-child",
      artifactPath,
      expectedSha256,
      realpathSync(containmentRoot),
      requirementsJson,
    ],
    {
      env: importChildEnvironment(),
      execArgv: [
        "--permission",
        "--disable-sigusr1",
        "--no-global-search-paths",
        ...allowedRoots.map((root) => `--allow-fs-read=${root}`),
      ],
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );

  let output = "";
  let outputOverflow = false;
  const capture = (chunk) => {
    if (outputOverflow) return;
    output += chunk.toString("utf8");
    if (Buffer.byteLength(output, "utf8") > MAX_IMPORT_OUTPUT_BYTES) {
      outputOverflow = true;
      output = output.slice(0, MAX_IMPORT_OUTPUT_BYTES);
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  let ready = false;
  let proof = false;
  let publicKey;
  let protocolError = null;
  let messageChain = Promise.resolve();
  child.on("message", (message) => {
    messageChain = messageChain.then(async () => {
      if (protocolError !== null) return;
      try {
        if (message === null || typeof message !== "object" || Array.isArray(message)) {
          throw new Error("import probe sent a non-object frame");
        }
        if (message.type === "ready") {
          if (
            ready ||
            JSON.stringify(Object.keys(message).sort()) !==
              JSON.stringify(["protocol", "publicKey", "type"]) ||
            message.protocol !== IMPORT_PROTOCOL
          ) {
            throw new Error("import probe sent an invalid or duplicate ready frame");
          }
          const spki = canonicalBase64(message.publicKey, "import public key", 256);
          publicKey = await webcrypto.subtle.importKey(
            "spki",
            spki,
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"],
          );
          ready = true;
          child.send({ type: "challenge", challenge: challenge.toString("base64") });
          return;
        }
        if (message.type === "proof") {
          if (
            !ready ||
            proof ||
            JSON.stringify(Object.keys(message).sort()) !==
              JSON.stringify(["protocol", "signature", "type"]) ||
            message.protocol !== IMPORT_PROTOCOL
          ) {
            throw new Error("import probe sent an invalid or premature proof frame");
          }
          const signature = canonicalBase64(message.signature, "import signature", 256);
          proof = await webcrypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" },
            publicKey,
            signature,
            importStatement(challenge, expectedSha256, requirementsJson),
          );
          if (!proof) throw new Error("import probe signature verification failed");
          return;
        }
        throw new Error("import probe sent an unknown frame");
      } catch (error) {
        protocolError = error;
        child.kill("SIGKILL");
      }
    });
  });

  const exitResult = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "TIMEOUT" });
    }, timeoutMs);
    const finish = (value) => {
      clearTimeout(timeout);
      resolve(value);
    };
    child.once("error", (error) => finish({ error, code: null, signal: null }));
    child.once("exit", (code, signal) => finish({ code, signal }));
  });
  await messageChain;

  let error = protocolError;
  if (error === null && outputOverflow) error = new Error("import probe output exceeded 64 KiB");
  if (error === null && exitResult.error) error = exitResult.error;
  if (error === null && exitResult.signal === "TIMEOUT") error = new Error("import probe timed out");
  if (error === null && (exitResult.code !== 0 || exitResult.signal !== null)) {
    error = new Error(`import probe exited with ${exitResult.signal ?? `code ${exitResult.code}`}`);
  }
  if (error === null && (!ready || !proof)) {
    error = new Error("import probe exited without a verified completion proof");
  }
  if (error === null && regularFileSha256(artifactPath, containmentRoot) !== expectedSha256) {
    error = new Error("TUI import artifact changed during the probe");
  }
  return Object.freeze({ ok: error === null, error, output });
}

function loadPtyModule() {
  try {
    return requireFromRuntime("node-pty");
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(
      `node-pty is required for TUI runtime startup validation under ${process.version}: ${message}`,
    );
  }
}

function scanOutput(buffer) {
  const matches = [];
  for (const pattern of FATAL_PATTERNS) {
    const match = buffer.match(pattern);
    if (match) matches.push({ pattern: pattern.source, hit: match[0] });
  }
  return matches;
}

function ptyEnvironment() {
  const allowed = [
    "AGENC_AUTH_BACKEND",
    "AGENC_CONFIG_DIR",
    "AGENC_HOME",
    "CI",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "NO_COLOR",
    "PATH",
    "SHELL",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "TZ",
    "USER",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ];
  const environment = Object.fromEntries(
    allowed.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
  );
  return {
    ...environment,
    AGENC_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    NODE_OPTIONS: "",
    TERM: "xterm-256color",
  };
}

function safePtyKill(term, signal) {
  try {
    if (process.platform === "win32") term.kill();
    else term.kill(signal);
  } catch {
    // The onExit observation below is authoritative.
  }
}

export function hasSemanticPtyReadiness(buffer) {
  return (
    typeof buffer === "string" &&
    Buffer.byteLength(buffer, "utf8") >= MIN_SEMANTIC_PAINT_BYTES &&
    buffer.includes("\x1b[?2004h") &&
    /agenc/iu.test(buffer)
  );
}

async function waitForPhaseOrExit(exitPromise, milliseconds) {
  return Promise.race([
    delay(milliseconds).then(() => ({ kind: "timer" })),
    exitPromise.then((exit) => ({ kind: "exit", exit })),
  ]);
}

export async function observePtySession(term, {
  label,
  viewport,
  firstPaintMs = FIRST_PAINT_MS,
  postReplyMs = POST_REPLY_MS,
  sigtermGraceMs = SIGTERM_GRACE_MS,
  forceKillGraceMs = FORCE_KILL_GRACE_MS,
} = {}) {
  let buffer = "";
  let overflow = false;
  const dataSubscription = term.onData((data) => {
    if (overflow) return;
    if (Buffer.byteLength(buffer, "utf8") + Buffer.byteLength(data, "utf8") > MAX_PTY_OUTPUT_BYTES) {
      overflow = true;
      safePtyKill(term, "SIGKILL");
      return;
    }
    buffer += data;
  });
  let exited = false;
  let exitValue;
  const exitPromise = new Promise((resolve) => {
    term.onExit((value) => {
      exited = true;
      exitValue = value;
      resolve(value);
    });
  });

  let earlyFailure = null;
  try {
    const firstPaint = await waitForPhaseOrExit(exitPromise, firstPaintMs);
    if (firstPaint.kind === "exit") {
      earlyFailure = `exited before first paint (code ${firstPaint.exit.exitCode}, signal ${firstPaint.exit.signal})`;
    } else if (buffer.length === 0) {
      earlyFailure = "produced no first-paint output";
    } else {
      term.write(XTVERSION_REPLY);
      term.write(DA1_REPLY);
      const reply = await waitForPhaseOrExit(exitPromise, postReplyMs);
      if (reply.kind === "exit") {
        earlyFailure = `exited before the post-reply observation (code ${reply.exit.exitCode}, signal ${reply.exit.signal})`;
      }
    }

    const terminationRequested = !exited;
    if (!terminationRequested && earlyFailure === null) {
      earlyFailure = `exited before requested termination (code ${exitValue.exitCode}, signal ${exitValue.signal})`;
    }
    if (terminationRequested) safePtyKill(term, "SIGTERM");
    const graceful = exited
      ? { kind: "exit", exit: exitValue }
      : await waitForPhaseOrExit(exitPromise, sigtermGraceMs);
    let survivedTermination = false;
    if (graceful.kind !== "exit") {
      survivedTermination = true;
      safePtyKill(term, "SIGKILL");
      await waitForPhaseOrExit(exitPromise, forceKillGraceMs);
    }
    const gracefulExit = graceful.kind === "exit" ? graceful.exit : null;
    const invalidTerminationExit = terminationRequested && gracefulExit !== null && !(
      (
        gracefulExit.exitCode === 0 &&
        (gracefulExit.signal === 0 || gracefulExit.signal === undefined)
      ) ||
      (process.platform !== "win32" && gracefulExit.signal === 15)
    );

    const matches = scanOutput(buffer);
    const semanticReadiness = hasSemanticPtyReadiness(buffer);
    if (
      earlyFailure === null &&
      !overflow &&
      !survivedTermination &&
      !invalidTerminationExit &&
      semanticReadiness &&
      matches.length === 0
    ) {
      console.log(green(`[3/4] ${label} ${viewport.cols}x${viewport.rows}: clean startup`));
      return true;
    }
    console.error(red(`[3/4] ${label} ${viewport.cols}x${viewport.rows}: FAILED`));
    if (earlyFailure !== null) console.error(red(`        ${earlyFailure}`));
    if (overflow) console.error(red("        PTY output exceeded 1 MiB"));
    if (survivedTermination) console.error(red("        PTY survived the SIGTERM grace period"));
    if (!semanticReadiness) {
      console.error(red("        PTY never rendered the AgenC interactive screen invariant"));
    }
    if (invalidTerminationExit) {
      console.error(red(
        `        PTY failed during SIGTERM grace (code ${gracefulExit.exitCode}, signal ${gracefulExit.signal})`,
      ));
    }
    for (const { pattern, hit } of matches) {
      console.error(red(`        pattern /${pattern}/i hit: ${hit.trim()}`));
    }
    const tail = buffer.split(/\r?\n/).slice(-60).join("\n");
    if (tail !== "") console.error(tail);
    return false;
  } finally {
    dataSubscription.dispose();
    if (!exited) safePtyKill(term, "SIGKILL");
  }
}

async function ptyStartupSmoke(label, args, viewport) {
  const pty = loadPtyModule();
  console.log(
    `[3/4] PTY spawn ${label} ${viewport.cols}x${viewport.rows}: ${args.join(" ") || "(no args)"}`,
  );
  const term = pty.spawn(process.execPath, [BIN_AGENC_PATH, ...args], {
    name: "xterm-256color",
    cols: viewport.cols,
    rows: viewport.rows,
    cwd: RUNTIME_DIR,
    env: ptyEnvironment(),
  });
  return observePtySession(term, { label, viewport });
}

async function main() {
  console.log(`[1/4] importing ${path.relative(RUNTIME_DIR, DIST_ROOT_PATH)} in a proof child ...`);
  const rootImported = await runImportProbe({
    artifactPath: DIST_ROOT_PATH,
    requiredExports: {
      AgenCDaemonJsonRpcDispatcher: "present",
      AgenCInProcessDaemonTransport: "present",
      VERSION: "present",
      startAgenCInProcessDaemonTransport: "function",
    },
  });
  if (!rootImported.ok) {
    console.error(red(`[1/4] FAILED: ${rootImported.error?.message ?? "unknown import error"}`));
    if (rootImported.output.trim() !== "") console.error(rootImported.output.trim());
    return 1;
  }
  console.log(green("[1/4] runtime root returned a verified import proof"));

  console.log(`[2/4] importing ${path.relative(RUNTIME_DIR, DIST_TUI_PATH)} in a proof child ...`);
  const imported = await runImportProbe();
  if (!imported.ok) {
    console.error(red(`[2/4] FAILED: ${imported.error?.message ?? "unknown import error"}`));
    if (imported.output.trim() !== "") console.error(imported.output.trim());
    return 1;
  }
  console.log(green("[2/4] built TUI artifact returned a verified import proof"));

  const results = [];
  for (const viewport of VIEWPORTS) {
    results.push(await ptyStartupSmoke("agenc", [], viewport));
    results.push(await ptyStartupSmoke("agenc --yolo", ["--yolo"], viewport));
  }
  if (results.every(Boolean)) {
    console.log(green("[4/4] TUI runtime startup smoke passed"));
    return 0;
  }
  console.error(red("[4/4] TUI runtime startup smoke FAILED"));
  return 1;
}

function isEntrypoint() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === SCRIPT_PATH;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  try {
    if (process.argv[2] === "--import-probe-child") {
      if (process.argv.length !== 7) throw new Error("invalid import probe child arguments");
      await importProbeChild(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
    } else {
      if (process.argv.length !== 2) throw new Error("TUI runtime startup smoke takes no arguments");
      process.exitCode = await main();
    }
  } catch (error) {
    process.stderr.write(
      `startup smoke crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
