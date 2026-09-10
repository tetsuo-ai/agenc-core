export function convertWindowsPathToPosix(windowsPath: string): string {
  if (windowsPath.startsWith('\\\\')) {
    return windowsPath.replace(/\\/g, '/')
  }
  const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\]/)
  if (driveMatch) {
    const driveLetter = driveMatch[1]!.toLowerCase()
    return '/' + driveLetter + windowsPath.slice(2).replace(/\\/g, '/')
  }
  return windowsPath.replace(/\\/g, '/')
}
