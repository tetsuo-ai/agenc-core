import React from "react";
import { describe, expect, test } from "vitest";

import { renderToString } from "../../../utils/staticRender.js";
import Text from "../../ink/components/Text.js";
import {
  ExpandShellOutputProvider,
  useExpandShellOutput,
} from "./ExpandShellOutputContext.js";

function ExpandProbe() {
  return <Text>{useExpandShellOutput() ? "expanded" : "collapsed"}</Text>;
}

function RerenderProvider() {
  const [tick, setTick] = React.useState(0);
  const child = React.useMemo(() => <ExpandProbe />, []);

  React.useLayoutEffect(() => {
    if (tick === 0) {
      setTick(1);
    }
  }, [tick]);

  return <ExpandShellOutputProvider>{child}</ExpandShellOutputProvider>;
}

describe("ExpandShellOutputContext", () => {
  test("defaults to collapsed outside the provider", async () => {
    await expect(renderToString(<ExpandProbe />, 20)).resolves.toContain(
      "collapsed",
    );
  });

  test("marks shell output as expanded inside the provider", async () => {
    await expect(renderToString(<RerenderProvider />, 20)).resolves.toContain(
      "expanded",
    );
  });
});
