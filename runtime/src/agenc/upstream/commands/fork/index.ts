export default {
  type: "local",
  name: "fork",
  description: "Fork command is unavailable in this AgenC source tree.",
  supportsNonInteractive: false,
  async load() {
    throw new Error("Fork command is unavailable in this AgenC source tree.");
  },
};
