/**
 * CPU-profiling driver: replays the long fixture in a tight loop so the
 * V8 CPU profiler sees the stream-processing path, not startup.
 *
 * Run:
 *   cd runtime && mkdir -p benchmarks/deepseek-stream/results/cpu-prof && \
 *   ~/workspace/.toolchain/node-v26.12.1-linux-x64/bin/node \
 *     --cpu-prof --cpu-prof-dir=benchmarks/deepseek-stream/results/cpu-prof \
 *     --cpu-prof-name=long.cpuprofile \
 *     --import tsx benchmarks/deepseek-stream/profile-loop.mts
 * Iterations: PROFILE_ITERATIONS env (default 120).
 */
import { loadFixture, makeProvider, runOnce } from "./lib.mts";

const iterations = Number(process.env.PROFILE_ITERATIONS ?? 120);
const fixture = loadFixture("long");
// A few untimed warmups so JIT compilation does not dominate the profile.
for (let i = 0; i < 5; i++) await runOnce(makeProvider(fixture.chunks));
const start = performance.now();
for (let i = 0; i < iterations; i++) {
  await runOnce(makeProvider(fixture.chunks));
}
console.log(`profile loop: ${iterations} iterations in ${(performance.now() - start).toFixed(1)}ms`);
