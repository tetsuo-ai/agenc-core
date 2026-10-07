// The installed CommonJS subpaths expose these same barrel functions.
declare module "semver/functions/compare.js" {
  export { compare as default } from "semver";
}
declare module "semver/functions/gt.js" {
  export { gt as default } from "semver";
}
declare module "semver/functions/gte.js" {
  export { gte as default } from "semver";
}
declare module "semver/functions/lt.js" {
  export { lt as default } from "semver";
}
declare module "semver/functions/lte.js" {
  export { lte as default } from "semver";
}
declare module "semver/functions/satisfies.js" {
  export { satisfies as default } from "semver";
}
