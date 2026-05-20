import React from "react";
import { describe, expect, test } from "vitest";

import Text from "../ink/components/Text.js";
import { renderToString } from "../../utils/staticRender.js";
import {
  FpsMetricsProvider,
  useFpsMetrics,
} from "./fpsMetrics.js";

const getMetrics = () => ({
  averageFps: 60,
  low1PctFps: 42,
  sampleCount: 12,
});

function MetricsProbe() {
  const getFpsMetrics = useFpsMetrics();
  const metrics = getFpsMetrics?.();

  return <Text>{metrics ? String(metrics.averageFps) : "none"}</Text>;
}

function RerenderProvider() {
  const [tick, setTick] = React.useState(0);
  const child = React.useMemo(() => <MetricsProbe />, []);

  React.useLayoutEffect(() => {
    if (tick === 0) {
      setTick(1);
    }
  }, [tick]);

  return (
    <FpsMetricsProvider getFpsMetrics={getMetrics}>
      {child}
    </FpsMetricsProvider>
  );
}

describe("fpsMetrics context", () => {
  test("returns undefined when no FPS metrics provider is mounted", async () => {
    await expect(renderToString(<MetricsProbe />, 20)).resolves.toContain(
      "none",
    );
  });

  test("provides the FPS metrics getter to descendants", async () => {
    await expect(renderToString(<RerenderProvider />, 20)).resolves.toContain(
      "60",
    );
  });
});
