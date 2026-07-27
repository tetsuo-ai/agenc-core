import { readFileSync } from "node:fs";

interface ReleaseToolchain {
  readonly docker: {
    readonly buildImage: string;
    readonly runtimeImage: string;
  };
}

const releaseToolchain = JSON.parse(
  readFileSync(new URL("../../../release-toolchain.json", import.meta.url), "utf8"),
) as ReleaseToolchain;

export const PINNED_DOCKER_BUILD_IMAGE = releaseToolchain.docker.buildImage;
export const PINNED_DOCKER_RUNTIME_IMAGE = releaseToolchain.docker.runtimeImage;
