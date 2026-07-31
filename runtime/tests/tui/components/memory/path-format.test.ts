import { describe, expect, test, vi } from 'vitest';

vi.mock('os', () => ({
  homedir: () => '/home/tester',
}));

vi.mock('../../../utils/cwd.js', () => ({
  getCwd: () => '/home/tester/project',
}));

import {
  getRelativeMemoryPath,
  getRelativeMemoryPathForRoots,
} from './path-format.js';

describe('memory path display formatting', () => {
  test('formats paths relative to home, cwd, or neither root', () => {
    expect(
      getRelativeMemoryPathForRoots(
        '/home/user',
        '/home/user',
        '/workspace/project',
      ),
    ).toBe('~');
    expect(
      getRelativeMemoryPathForRoots(
        '/workspace/project',
        '/home/user',
        '/workspace/project',
      ),
    ).toBe('.');
    expect(
      getRelativeMemoryPathForRoots(
        '/home/user/.agenc/AGENC.md',
        '/home/user',
        '/workspace/project',
      ),
    ).toBe('~/.agenc/AGENC.md');
    expect(
      getRelativeMemoryPathForRoots(
        '/workspace/project/AGENC.md',
        '/home/user',
        '/workspace/project',
      ),
    ).toBe('./AGENC.md');
    expect(
      getRelativeMemoryPathForRoots(
        '/home/user/project/AGENC.md',
        '/home/user',
        '/home/user/project',
      ),
    ).toBe('./AGENC.md');
    expect(
      getRelativeMemoryPathForRoots(
        '/outside/AGENC.md',
        '/home/user',
        '/workspace/project',
      ),
    ).toBe('/outside/AGENC.md');
  });

  test('uses the current home and cwd roots', () => {
    expect(getRelativeMemoryPath('/home/tester/project/.agenc/memory.md')).toBe(
      './.agenc/memory.md',
    );
  });
});
