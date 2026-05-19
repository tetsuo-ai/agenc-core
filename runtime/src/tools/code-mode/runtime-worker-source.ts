export const QUICKJS_CODE_MODE_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { getQuickJS } = require("quickjs-emscripten");

const EXIT_SENTINEL = "__AGENC_CODE_MODE_EXIT__";

let vm = null;
let runtime = null;
let terminating = false;
let completed = false;
let nextToolCallId = 1;
let nextTimerId = 1;
const pendingTools = new Map();
const pendingYields = new Map();
const timers = new Map();
const storedValues = { ...(workerData.storedValues || {}) };

function post(message) {
  parentPort.postMessage(message);
}

function errorText(error) {
  if (error && typeof error === "object") {
    if (typeof error.message === "string") return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function dump(handle) {
  if (!handle) return undefined;
  return vm.dump(handle);
}

function toOutputText(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function toHandle(value) {
  if (value === undefined) return vm.undefined;
  if (value === null) return vm.null;
  if (typeof value === "boolean") return value ? vm.true : vm.false;
  if (typeof value === "number") return vm.newNumber(Number.isFinite(value) ? value : null);
  if (typeof value === "string") return vm.newString(value);
  if (Array.isArray(value)) {
    const array = vm.newArray();
    value.forEach((item, index) => {
      const child = toHandle(item);
      vm.setProp(array, index, child);
      if (child.alive && child !== vm.undefined && child !== vm.null && child !== vm.true && child !== vm.false) {
        child.dispose();
      }
    });
    return array;
  }
  if (typeof value === "object") {
    const object = vm.newObject();
    for (const [key, item] of Object.entries(value)) {
      const child = toHandle(item);
      vm.setProp(object, key, child);
      if (child.alive && child !== vm.undefined && child !== vm.null && child !== vm.true && child !== vm.false) {
        child.dispose();
      }
    }
    return object;
  }
  return vm.newString(String(value));
}

function disposeOwned(handle) {
  if (!handle || !handle.alive) return;
  if (handle === vm.undefined || handle === vm.null || handle === vm.true || handle === vm.false) return;
  handle.dispose();
}

function setGlobal(name, handle) {
  vm.setProp(vm.global, name, handle);
  disposeOwned(handle);
}

function setObjectProp(object, name, handle) {
  vm.setProp(object, name, handle);
  disposeOwned(handle);
}

function normalizeImage(value, detailOverride) {
  let imageUrl;
  let detail = detailOverride;
  if (typeof value === "string") {
    imageUrl = value;
  } else if (value && typeof value === "object") {
    if (typeof value.image_url === "string") {
      imageUrl = value.image_url;
    } else if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
      imageUrl = "data:" + value.mimeType + ";base64," + value.data;
      const meta = value._meta;
      if (detail === undefined && meta && typeof meta === "object") {
        const requested = meta["agenc/imageDetail"];
        if (typeof requested === "string") detail = requested;
      }
    }
    if (detail === undefined && typeof value.detail === "string") {
      detail = value.detail;
    }
  }
  if (!imageUrl) throw new Error("image expects a URL, data URL, or MCP image content block");
  const item = { type: "input_image", image_url: imageUrl };
  if (detail === "auto" || detail === "low" || detail === "high" || detail === "original") {
    item.detail = detail;
  }
  return item;
}

function pumpJobs() {
  if (!runtime) return;
  try {
    runtime.executePendingJobs();
  } catch (error) {
    if (!completed) {
      completed = true;
      post({ type: "result", storedValues, errorText: errorText(error) });
    }
  }
}

function makePromise() {
  return vm.newPromise();
}

function resolveDeferred(deferred, value) {
  const handle = toHandle(value);
  deferred.resolve(handle);
  disposeOwned(handle);
  pumpJobs();
}

function rejectDeferred(deferred, message) {
  const handle = vm.newString(message);
  deferred.reject(handle);
  handle.dispose();
  pumpJobs();
}

function installGlobals(enabledTools) {
  setGlobal("console", vm.undefined);

  setGlobal("text", vm.newFunction("text", (...args) => {
    const value = args.length > 0 ? dump(args[0]) : undefined;
    post({ type: "content_item", item: { type: "input_text", text: toOutputText(value) } });
    return vm.undefined;
  }));

  setGlobal("image", vm.newFunction("image", (...args) => {
    const value = args.length > 0 ? dump(args[0]) : undefined;
    const detail = args.length > 1 ? dump(args[1]) : undefined;
    post({ type: "content_item", item: normalizeImage(value, detail) });
    return vm.undefined;
  }));

  setGlobal("store", vm.newFunction("store", (...args) => {
    const key = args.length > 0 ? dump(args[0]) : undefined;
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("store key must be a non-empty string");
    }
    const value = args.length > 1 ? dump(args[1]) : undefined;
    if (value === undefined) {
      throw new Error("store value must be serializable");
    }
    storedValues[key] = value;
    return vm.undefined;
  }));

  setGlobal("load", vm.newFunction("load", (...args) => {
    const key = args.length > 0 ? dump(args[0]) : undefined;
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("load key must be a non-empty string");
    }
    return toHandle(storedValues[key]);
  }));

  setGlobal("notify", vm.newFunction("notify", (...args) => {
    const value = args.length > 0 ? dump(args[0]) : undefined;
    const text = toOutputText(value);
    if (text.trim().length === 0) throw new Error("notify expects non-empty text");
    post({ type: "notify", callId: workerData.toolCallId, text });
    return vm.undefined;
  }));

  setGlobal("yield_control", vm.newFunction("yield_control", () => {
    const id = "yield-" + Date.now() + "-" + pendingYields.size;
    const deferred = makePromise();
    pendingYields.set(id, deferred);
    post({ type: "yield_requested", id });
    return deferred.handle;
  }));

  setGlobal("exit", vm.newFunction("exit", () => {
    throw new Error(EXIT_SENTINEL);
  }));

  setGlobal("setTimeout", vm.newFunction("setTimeout", (...args) => {
    const callback = args[0];
    if (!callback || vm.typeof(callback) !== "function") {
      throw new Error("setTimeout expects a callback function");
    }
    const delayValue = args.length > 1 ? dump(args[1]) : 0;
    const delayMs = Math.max(0, Number(delayValue) || 0);
    const id = nextTimerId++;
    const callbackRef = callback.dup();
    const timer = setTimeout(() => {
      timers.delete(id);
      if (terminating || completed) {
        disposeOwned(callbackRef);
        return;
      }
      const result = vm.callFunction(callbackRef, vm.undefined);
      if (result.error) {
        const dumped = dump(result.error);
        result.error.dispose();
        if (!completed) {
          completed = true;
          post({ type: "result", storedValues, errorText: errorText(dumped) });
        }
      } else {
        disposeOwned(result.value);
        pumpJobs();
      }
      disposeOwned(callbackRef);
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
    timers.set(id, timer);
    return vm.newNumber(id);
  }));

  setGlobal("clearTimeout", vm.newFunction("clearTimeout", (...args) => {
    const id = args.length > 0 ? Number(dump(args[0])) : NaN;
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
    return vm.undefined;
  }));

  const allTools = vm.newArray();
  const tools = vm.newObject();
  enabledTools.forEach((tool, index) => {
    const metadata = vm.newObject();
    setObjectProp(metadata, "name", vm.newString(tool.globalName));
    setObjectProp(metadata, "description", vm.newString(tool.description || ""));
    vm.setProp(allTools, index, metadata);
    metadata.dispose();

    const fn = vm.newFunction(tool.globalName, (...args) => {
      const id = "tool-" + nextToolCallId++;
      const input = args.length > 0 ? dump(args[0]) : undefined;
      const deferred = makePromise();
      pendingTools.set(id, deferred);
      post({ type: "tool_call", id, name: tool.name, input });
      return deferred.handle;
    });
    vm.setProp(tools, tool.globalName, fn);
    fn.dispose();
  });
  setGlobal("ALL_TOOLS", allTools);
  setGlobal("tools", tools);
}

parentPort.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "tool_response") {
    const deferred = pendingTools.get(message.id);
    if (!deferred) return;
    pendingTools.delete(message.id);
    resolveDeferred(deferred, message.result);
    return;
  }
  if (message.type === "tool_error") {
    const deferred = pendingTools.get(message.id);
    if (!deferred) return;
    pendingTools.delete(message.id);
    rejectDeferred(deferred, message.error || "tool call failed");
    return;
  }
  if (message.type === "continue") {
    for (const [id, deferred] of pendingYields.entries()) {
      pendingYields.delete(id);
      resolveDeferred(deferred, undefined);
    }
    return;
  }
  if (message.type === "terminate") {
    terminating = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const [id, deferred] of pendingTools.entries()) {
      pendingTools.delete(id);
      rejectDeferred(deferred, "exec cell terminated");
    }
    for (const [id, deferred] of pendingYields.entries()) {
      pendingYields.delete(id);
      resolveDeferred(deferred, undefined);
    }
  }
});

(async () => {
  try {
    const QuickJS = await getQuickJS();
    runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(64 * 1024 * 1024);
    runtime.setMaxStackSize(2 * 1024 * 1024);
    vm = runtime.newContext();
    installGlobals(workerData.enabledTools || []);
    post({ type: "started" });

    const wrapped = "(async () => {\n" + workerData.source + "\n})()";
    const evalResult = vm.evalCode(wrapped, "agenc-exec.js");
    if (evalResult.error) {
      const dumped = dump(evalResult.error);
      evalResult.error.dispose();
      if (errorText(dumped).includes(EXIT_SENTINEL)) {
        completed = true;
        post({ type: "result", storedValues });
        return;
      }
      completed = true;
      post({ type: "result", storedValues, errorText: errorText(dumped) });
      return;
    }

    const settledPromise = vm.resolvePromise(evalResult.value);
    pumpJobs();
    const settled = await settledPromise;
    disposeOwned(evalResult.value);
    if (completed) return;
    completed = true;
    if (settled.error) {
      const dumped = dump(settled.error);
      settled.error.dispose();
      if (errorText(dumped).includes(EXIT_SENTINEL)) {
        post({ type: "result", storedValues });
      } else {
        post({ type: "result", storedValues, errorText: errorText(dumped) });
      }
    } else {
      disposeOwned(settled.value);
      post({ type: "result", storedValues });
    }
  } catch (error) {
    if (!completed) {
      completed = true;
      post({ type: "result", storedValues, errorText: errorText(error) });
    }
  }
})();
`;
