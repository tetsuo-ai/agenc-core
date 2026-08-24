import { describe, expect, it } from 'vitest';

describe('Z-PURGEA moved source importability', () => {
  it('loads moved utils and constants through the Vitest resolver', async () => {
    const cwd = await import('../src/utils/cwd.ts');
    const home = await import('../src/config/home.ts');
    const systemPromptSections = await import('../src/constants/systemPromptSections.ts');

    expect(cwd.getCwd).toBeTypeOf('function');
    expect(home.resolveHomeContext).toBeTypeOf('function');
    expect(systemPromptSections.systemPromptSection).toBeTypeOf('function');
  });
});
