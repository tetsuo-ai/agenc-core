const SHA256 = /^[0-9a-f]{64}$/;
const OFFICIAL_INVENTORY_URL =
  /^https:\/\/raw\.githubusercontent\.com\/actions\/runner-images\/[0-9a-f]{40}\/images\/(?:macos|windows)\/[A-Za-z0-9._-]+-Readme\.md$/;

const PROFILE_FIELDS = Object.freeze({
  darwin: Object.freeze([
    "xcodeVersion",
    "xcodeBuild",
    "macosSdkVersion",
    "clangVersion",
  ]),
  windows: Object.freeze([
    "visualStudioVersion",
    "visualStudioInstallPath",
    "msvcToolsVersion",
    "msvcCompilerVersion",
    "windowsSdkVersion",
  ]),
});

function profileFields(slug) {
  if (slug.startsWith("darwin-")) return PROFILE_FIELDS.darwin;
  if (slug === "win-x64") return PROFILE_FIELDS.windows;
  throw new Error(`unsupported hosted runner release slug: ${slug}`);
}

export function reviewedHostedRunnerImageProfiles(contract, slug) {
  const profiles = contract?.imageProfiles;
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new Error(
      `release-toolchain.json has invalid hosted image profiles for ${slug}`,
    );
  }
  const requiredFields = profileFields(slug);
  const imageVersions = new Set();
  for (const profile of profiles) {
    if (
      profile === null ||
      typeof profile !== "object" ||
      Array.isArray(profile) ||
      typeof profile.imageVersion !== "string" ||
      profile.imageVersion.length === 0 ||
      typeof profile.inventoryUrl !== "string" ||
      !OFFICIAL_INVENTORY_URL.test(profile.inventoryUrl) ||
      typeof profile.inventorySha256 !== "string" ||
      !SHA256.test(profile.inventorySha256) ||
      !Number.isSafeInteger(profile.inventoryBytes) ||
      profile.inventoryBytes <= 0 ||
      requiredFields.some(
        (field) =>
          typeof profile[field] !== "string" || profile[field].length === 0,
      )
    ) {
      throw new Error(
        `release-toolchain.json has invalid hosted image profiles for ${slug}`,
      );
    }
    if (
      slug === "win-x64" &&
      (
        !SHA256.test(profile.msvcCompilerSha256 ?? "") ||
        !SHA256.test(profile.msvcLinkerSha256 ?? "")
      )
    ) {
      throw new Error(
        `release-toolchain.json has invalid hosted image profiles for ${slug}`,
      );
    }
    if (imageVersions.has(profile.imageVersion)) {
      throw new Error(
        `release-toolchain.json has duplicate hosted image profiles for ${slug}`,
      );
    }
    imageVersions.add(profile.imageVersion);
  }
  return profiles;
}

export function resolveHostedRunnerImageProfile(contract, imageVersion, slug) {
  const profiles = reviewedHostedRunnerImageProfiles(contract, slug);
  const profile = profiles.find(
    (candidate) => candidate.imageVersion === imageVersion,
  );
  if (profile === undefined) {
    throw new Error(
      `release ${slug} runnerImageVersion does not match release-toolchain.json: ` +
      `${imageVersion ?? "missing"} not in ${profiles
        .map((candidate) => candidate.imageVersion)
        .join(", ")}`,
    );
  }
  return profile;
}

export function expectedHostedRunnerBuilder(contract, imageVersion) {
  return `github-hosted:${contract.runnerLabel}:${contract.imageOS}:` +
    `${imageVersion}:${contract.runnerArch}`;
}
