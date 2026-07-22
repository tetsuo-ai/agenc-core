/**
 * Force production React in built artifacts. MUST be the first static import
 * of every bundle entry point: ESM executes imports in order, and
 * `react-reconciler` (kept external for the React-singleton constraint)
 * selects its build from `process.env.NODE_ENV` at require time. Installs
 * never set NODE_ENV, so without this every production install loaded the
 * DEVELOPMENT reconciler, whose scheduling profiler emits
 * performance.mark()/measure() per unit of React work. Node retains user
 * timing entries until cleared, so a long animated session (90ms spinner ×
 * an hour-long swarm turn) accumulated millions of PerformanceMeasure
 * entries and dev-mode debug allocations until the V8 heap limit killed the
 * TUI with SIGABRT.
 *
 * `??=` so an explicitly-set NODE_ENV (tests, debugging a dev reconciler on
 * purpose) still wins.
 */
process.env.NODE_ENV ??= "production";

export {};
