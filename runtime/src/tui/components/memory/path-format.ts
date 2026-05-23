import { isAbsolute, relative } from 'path';

import { isRelativePathOutsideBase } from '../../pathDisplay.js';

function containedRelativePath(basePath: string, targetPath: string): string | null {
  const relativePath = relative(basePath, targetPath);
  if (relativePath === '') return '';
  if (isRelativePathOutsideBase(relativePath) || isAbsolute(relativePath)) return null;
  return relativePath;
}

export function getRelativeMemoryPathForRoots(
  memoryPath: string,
  homeDir: string,
  cwd: string,
): string {
  const homeRelativePath = containedRelativePath(homeDir, memoryPath);
  const cwdRelativePath = containedRelativePath(cwd, memoryPath);
  const relativeToHome =
    homeRelativePath === null
      ? null
      : homeRelativePath === ''
        ? '~'
        : `~/${homeRelativePath}`;
  const relativeToCwd =
    cwdRelativePath === null
      ? null
      : cwdRelativePath === ''
        ? '.'
        : `./${cwdRelativePath}`;

  if (relativeToHome && relativeToCwd) {
    return relativeToHome.length <= relativeToCwd.length
      ? relativeToHome
      : relativeToCwd;
  }
  return relativeToHome || relativeToCwd || memoryPath;
}
