export interface LinuxLauncherBuildInfo {
  readonly systemBubblewrapRequired: boolean;
  readonly seccompTransport: "bwrap-fd";
}

export function linuxLauncherBuildInfo(): LinuxLauncherBuildInfo {
  return {
    systemBubblewrapRequired: true,
    seccompTransport: "bwrap-fd",
  };
}
