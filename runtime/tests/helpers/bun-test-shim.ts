import { vi } from 'vitest';

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
} from 'vitest';

export const mock = Object.assign(vi.fn, {
  restore() {
    vi.restoreAllMocks();
    vi.resetModules();
  },
});

