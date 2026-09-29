import type { AttachmentProducer } from "./orchestrator.js";

/** Mentioning an available tool should not be mistaken for its absence. */
export const requestedToolsProducer: AttachmentProducer = async (opts, tracking) => {
  const provenance = opts.turnProvenance;
  const human = provenance?.rootHumanTurn;
  if (!opts.lightMode || !human || human.turnId !== provenance?.turnId ||
      tracking.lastRequestedToolsTurnId === human.turnId) return [];
  tracking.lastRequestedToolsTurnId = human.turnId;
  const mentioned = new Set(human.text.match(/\w+(?:[.-]\w+)*/gu) ?? []);
  const visible = new Set(opts.loadedTools.map(tool => tool.function.name));
  const names = [...new Set(opts.catalogToolNames ?? [])]
    .filter(name => /^[\w.-]{1,100}$/u.test(name) && mentioned.has(name) && !visible.has(name))
    .sort().slice(0, 8);
  return names.length > 0 ? [{ kind: "requested_tools", names }] : [];
};
