import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';
import { loadConfigFromFile } from 'vite';

import {
  HERMETIC_LIVE_TEST_OPT_IN_ENV_VARS,
  sanitizeHermeticEnv,
} from './helpers/hermetic-env.mjs';

const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const vitestCli = resolve(runtimeRoot, '../node_modules/vitest/vitest.mjs');
const hermeticPrelauncher = resolve(
  runtimeRoot,
  'scripts/run-hermetic-vitest.mjs',
);
const HERMETIC_ENV_CONTRACT = JSON.parse(
  readFileSync(
    resolve(runtimeRoot, 'tests/fixtures/hermetic-env-contract.json'),
    'utf8',
  ),
) as string[];

const LIVE_TEST_FILES = [
  'tests/browser/live-e2e.test.ts',
  'tests/live/grok-full-surface-e2e.live.test.ts',
  'tests/live/imagine-video-e2e.live.test.ts',
  'tests/live/xsearch-retry.live.test.ts',
  'tests/llm/provider.integration.test.ts',
  'tests/transaction-guard/devnet-live.e2e.test.ts',
] as const;

const DESIGN_TEST_FILES = [
  'tests/design-hermetic-env.test.ts',
  'tests/tui/components/v2/designStateSmoke.test.tsx',
] as const;

const CROSS_REPO_TEST_FILES = [
  'tests/app-server-protocol/ide-extension.repo.contract.test.ts',
  'tests/app-server/protocol.contract.test.ts',
  'tests/app-server/sdk-client.contract.test.ts',
  'tests/app-server/sdk-hello-world-example.contract.test.ts',
  'tests/app-server/sdk-tui-coattach-example.contract.test.ts',
] as const;

function listTestFiles(config: string): string[] {
  const result = spawnSync(
    process.execPath,
    [vitestCli, 'list', '--filesOnly', '--config', config],
    {
      cwd: runtimeRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    },
  );

  expect(
    result.status,
    `vitest list failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\.test\.tsx?$/.test(line))
    .map((file) => {
      const absolute = isAbsolute(file) ? file : resolve(runtimeRoot, file);
      return relative(runtimeRoot, absolute).split('\\').join('/');
    })
    .sort();
}

describe('hermetic test discovery', () => {
  it('keeps every external-I/O test out of default discovery', () => {
    const files = listTestFiles('vitest.config.ts');

    for (const liveFile of LIVE_TEST_FILES) {
      expect(files, `${liveFile} leaked into the default suite`).not.toContain(liveFile);
    }

    for (const designFile of DESIGN_TEST_FILES) {
      expect(files, `${designFile} leaked into the default suite`).not.toContain(
        designFile,
      );
    }

    for (const crossRepoFile of CROSS_REPO_TEST_FILES) {
      expect(
        files,
        `${crossRepoFile} leaked into the clean-checkout suite`,
      ).not.toContain(crossRepoFile);
    }

    // Despite its historical filename, this test only inspects production
    // rendering source and is intentionally part of the offline suite.
    expect(files).toContain(
      'tests/tui/parity/HookProgressMessage.live.parity.test.ts',
    );
  });

  it('live discovery is an explicit allowlist of external-I/O tests', () => {
    expect(listTestFiles('vitest.live.config.ts')).toEqual([...LIVE_TEST_FILES]);
  });

  it('design discovery is an explicit least-privilege design-audit surface', () => {
    expect(listTestFiles('vitest.design.config.ts')).toEqual([...DESIGN_TEST_FILES]);
  });

  it('cross-repo discovery is an explicit non-gating allowlist', () => {
    expect(listTestFiles('vitest.cross-repo.config.ts')).toEqual([
      ...CROSS_REPO_TEST_FILES,
    ]);
  });

  it('loads live mode with no setup files while default mode keeps its setup', async () => {
    const environment = { command: 'serve', mode: 'test' } as const;
    const defaultResult = await loadConfigFromFile(
      environment,
      resolve(runtimeRoot, 'vitest.config.ts'),
      runtimeRoot,
    );
    const liveResult = await loadConfigFromFile(
      environment,
      resolve(runtimeRoot, 'vitest.live.config.ts'),
      runtimeRoot,
    );
    const designResult = await loadConfigFromFile(
      environment,
      resolve(runtimeRoot, 'vitest.design.config.ts'),
      runtimeRoot,
    );
    const crossRepoResult = await loadConfigFromFile(
      environment,
      resolve(runtimeRoot, 'vitest.cross-repo.config.ts'),
      runtimeRoot,
    );

    expect(defaultResult?.config.test?.setupFiles).toEqual(['./vitest.setup.ts']);
    expect(liveResult?.config.test?.setupFiles).toEqual([]);
    expect(liveResult?.config.test?.include).toEqual(
      expect.arrayContaining([
        'tests/live/**/*.test.ts',
        'tests/live/**/*.test.tsx',
      ]),
    );
    expect(designResult?.config.test?.setupFiles).toEqual([
      './vitest.design.setup.ts',
    ]);
    expect(crossRepoResult?.config.test?.setupFiles).toEqual([
      './vitest.setup.ts',
    ]);
  });

  it('routes the transaction-guard live script through the live config', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(runtimeRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['test:transaction-guard:live']).toBe(
      'vitest run --config vitest.live.config.ts tests/transaction-guard/devnet-live.e2e.test.ts',
    );
  });

  it('strips the complete polluted env contract in a real default worker', () => {
    const pollutedEnv = Object.fromEntries(
      HERMETIC_ENV_CONTRACT.map((name) => [name, `ambient-${name}`]),
    );
    const osHome = userInfo().homedir;
    pollutedEnv.AGENC_TEST_HERMETIC_HOME = resolve(osHome, '.agenc');
    pollutedEnv.AGENC_CONFIG_DIR = resolve(osHome, '.agenc');
    pollutedEnv.AGENC_HOME = resolve(osHome, '.agenc');
    pollutedEnv.HOME = osHome;
    pollutedEnv.USERPROFILE = osHome;
    Object.assign(pollutedEnv, {
      AGENC_BUBBLEWRAP: '/ambient/bwrap',
      AGENC_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      AGENC_EXTRA_BODY: '{"ambient":true}',
      AGENC_GIT_BASH_PATH: '/ambient/bash',
      AGENC_OVERRIDE_DATE: '1900-01-01',
      AGENC_TEST_FIXTURES_ROOT: '/ambient/fixtures',
      AGENC_TMPDIR: '/ambient/tmp',
      CI: 'ambient-ci',
      GITHUB_DEVICE_FLOW_CLIENT_ID: 'ambient-client',
      TERM_PROGRAM: 'ambient-terminal',
      TEMP: resolve(osHome, `ambient-temp-${'x'.repeat(180)}`),
      TMP: resolve(osHome, `ambient-temp-${'x'.repeat(180)}`),
      TMPDIR: resolve(osHome, `ambient-temp-${'x'.repeat(180)}`),
      TZ: 'Pacific/Kiritimati',
    });
    const result = spawnSync(
      process.execPath,
      [
        hermeticPrelauncher,
        'run',
        'tests/hermetic-env.test.ts',
        '-t',
        'complete exported ambient list|points AGENC_HOME|canonical prelauncher environment',
        '--config',
        'vitest.config.ts',
        '--reporter=dot',
      ],
      {
        cwd: runtimeRoot,
        encoding: 'utf8',
        env: { ...process.env, ...pollutedEnv },
        timeout: 30_000,
      },
    );

    expect(
      result.status,
      `polluted default worker failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
  });

  it('strips every ambient live opt-in and known credential passphrase', () => {
    const env: NodeJS.ProcessEnv = {
      AGENC_CLIENT_KEY_PASSPHRASE: 'ambient-client-secret',
      AGENC_WALLET_VAULT_PASSPHRASE: 'ambient-wallet-secret',
    };
    for (const name of HERMETIC_LIVE_TEST_OPT_IN_ENV_VARS) env[name] = '1';

    sanitizeHermeticEnv(env, '/tmp/agenc-hermetic-discovery-test');

    for (const name of HERMETIC_LIVE_TEST_OPT_IN_ENV_VARS) {
      expect(env[name], `${name} survived sanitization`).toBeUndefined();
    }
    expect(env.AGENC_CLIENT_KEY_PASSPHRASE).toBeUndefined();
    expect(env.AGENC_WALLET_VAULT_PASSPHRASE).toBeUndefined();
  });

  it('routes default and design package scripts through the prelaunch sanitizer', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(runtimeRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.test).toBe(
      'node scripts/run-hermetic-test-boundary.mjs run',
    );
    expect(pkg.scripts?.['test:host-functional']).toBe(
      'node scripts/run-hermetic-vitest.mjs run',
    );
    expect(pkg.scripts?.['test:cross-repo']).toBe(
      'node scripts/run-hermetic-vitest.mjs run --config vitest.cross-repo.config.ts',
    );
    expect(pkg.scripts?.['check:tui-v2-design-audit']).toBe(
      'npm run build && node scripts/run-hermetic-vitest.mjs --design run --config vitest.design.config.ts && node scripts/check-tui-command-visual-smoke.mjs',
    );
  });

  it('ignores ambient Git repository overrides when resolving its readonly metadata mount', async () => {
    const expectedResult = spawnSync(
      'git',
      [
        '-C',
        runtimeRoot,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ],
      { encoding: 'utf8' },
    );
    expect(expectedResult.status, expectedResult.stderr).toBe(0);
    const expected = realpathSync(expectedResult.stdout.trim());
    const poison = mkdtempSync(join(tmpdir(), 'agenc-git-env-poison-'));
    const initialized = spawnSync('git', ['init', '--quiet', poison], {
      encoding: 'utf8',
    });
    expect(initialized.status, initialized.stderr).toBe(0);

    const names = ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    process.env.GIT_COMMON_DIR = resolve(poison, '.git');
    process.env.GIT_DIR = resolve(poison, '.git');
    process.env.GIT_INDEX_FILE = resolve(poison, '.git', 'index');
    process.env.GIT_WORK_TREE = poison;
    try {
      const boundaryUrl = new URL(
        '../scripts/run-hermetic-test-boundary.mjs',
        import.meta.url,
      );
      boundaryUrl.searchParams.set('git-env', String(Date.now()));
      const boundary = await import(/* @vite-ignore */ boundaryUrl.href) as {
        readonly gitCommonDirectory: string;
      };
      expect(boundary.gitCommonDirectory).toBe(expected);
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(poison, { force: true, recursive: true });
    }
  });

  it('resolves ripgrep from the pinned platform package without loading its facade', async () => {
    const boundaryUrl = new URL(
      '../scripts/run-hermetic-test-boundary.mjs',
      import.meta.url,
    );
    boundaryUrl.searchParams.set('ripgrep-resolution', String(Date.now()));
    const boundary = await import(/* @vite-ignore */ boundaryUrl.href) as {
      readonly resolveBundledRipgrepPath: (
        arch: string,
        resolveModule: (specifier: string) => string,
      ) => string;
    };
    for (const [arch, expectedSpecifier] of [
      ['x64', '@vscode/ripgrep-linux-x64/bin/rg'],
      ['arm64', '@vscode/ripgrep-linux-arm64/bin/rg'],
    ] as const) {
      const resolvedSpecifiers: string[] = [];
      const result = boundary.resolveBundledRipgrepPath(arch, (specifier) => {
        resolvedSpecifiers.push(specifier);
        return '/verified/repository/node_modules/platform-ripgrep/bin/rg';
      });

      expect(result).toBe(
        '/verified/repository/node_modules/platform-ripgrep/bin/rg',
      );
      expect(resolvedSpecifiers).toEqual([expectedSpecifier]);
    }
  });

  it('pins the Docker seccomp allowlist by reviewed content hash', async () => {
    const profileBytes = readFileSync(
      resolve(runtimeRoot, 'scripts/hermetic-docker-seccomp.json'),
    );
    const boundaryUrl = new URL(
      '../scripts/run-hermetic-test-boundary.mjs',
      import.meta.url,
    );
    boundaryUrl.searchParams.set('seccomp-profile', String(Date.now()));
    const boundary = await import(/* @vite-ignore */ boundaryUrl.href) as {
      readonly DOCKER_SECCOMP_PROFILE_SHA256: string;
    };

    expect(createHash('sha256').update(profileBytes).digest('hex')).toBe(
      boundary.DOCKER_SECCOMP_PROFILE_SHA256,
    );
    expect(JSON.parse(profileBytes.toString('utf8'))).toMatchObject({
      defaultAction: 'SCMP_ACT_ERRNO',
      defaultErrnoRet: 1,
    });
  });

  it('uses the exact release-toolchain Node image for the hermetic suite', async () => {
    const toolchain = JSON.parse(
      readFileSync(resolve(runtimeRoot, '../release-toolchain.json'), 'utf8'),
    ) as { readonly docker: { readonly buildImage: string } };
    const boundaryUrl = new URL(
      '../scripts/run-hermetic-test-boundary.mjs',
      import.meta.url,
    );
    boundaryUrl.searchParams.set('node-image', String(Date.now()));
    const boundary = await import(/* @vite-ignore */ boundaryUrl.href) as {
      readonly PINNED_NODE_IMAGE: string;
    };

    expect(boundary.PINNED_NODE_IMAGE).toBe(toolchain.docker.buildImage);
  });

  it('maps the container UID to an isolated writable account home', async () => {
    const boundaryUrl = new URL(
      '../scripts/run-hermetic-test-boundary.mjs',
      import.meta.url,
    );
    boundaryUrl.searchParams.set('account-passwd', String(Date.now()));
    const boundary = await import(/* @vite-ignore */ boundaryUrl.href) as {
      readonly boundaryPasswdEntry: (uid: number, gid: number) => string;
    };

    expect(boundary.boundaryPasswdEntry(1234, 5678)).toBe(
      'agenc-boundary:x:1234:5678:AgenC hermetic test:/tmp/agenc-boundary-home:/usr/sbin/nologin\n',
    );
    expect(() => boundary.boundaryPasswdEntry(-1, 5678)).toThrow(
      /non-negative integers/u,
    );
  });

  it('fails closed when the Docker boundary platform is too old or lacks seccomp', async () => {
    const boundaryUrl = new URL(
      '../scripts/run-hermetic-test-boundary.mjs',
      import.meta.url,
    );
    boundaryUrl.searchParams.set('platform-support', String(Date.now()));
    const boundary = await import(/* @vite-ignore */ boundaryUrl.href) as {
      readonly assertBoundaryPlatformSupport: (
        version: unknown,
        securityOptions: unknown,
      ) => void;
    };
    const supported = {
      Client: { ApiVersion: '1.44', Version: '25.0.0' },
      Server: {
        ApiVersion: '1.44',
        KernelVersion: '5.12.0',
        Os: 'linux',
        Version: '25.0.0',
      },
    };

    expect(() =>
      boundary.assertBoundaryPlatformSupport(supported, [
        'name=seccomp,profile=builtin',
      ]),
    ).not.toThrow();

    const unsupported = [
      [
        { ...supported, Client: { ...supported.Client, Version: '24.0.9' } },
        ['name=seccomp'],
        /Docker CLI 25\.0 or newer/u,
      ],
      [
        { ...supported, Client: { ...supported.Client, ApiVersion: '1.43' } },
        ['name=seccomp'],
        /Docker client API 1\.44 or newer/u,
      ],
      [
        { ...supported, Server: { ...supported.Server, Version: '24.0.9' } },
        ['name=seccomp'],
        /Docker Engine 25\.0 or newer/u,
      ],
      [
        { ...supported, Server: { ...supported.Server, ApiVersion: '1.43' } },
        ['name=seccomp'],
        /Docker Engine API 1\.44 or newer/u,
      ],
      [
        { ...supported, Server: { ...supported.Server, KernelVersion: '5.11.22' } },
        ['name=seccomp'],
        /Linux kernel 5\.12 or newer/u,
      ],
      [
        { ...supported, Server: { ...supported.Server, Os: 'windows' } },
        ['name=seccomp'],
        /Linux Docker Engine/u,
      ],
      [supported, [], /Linux seccomp enabled/u],
    ] as const;
    for (const [version, securityOptions, expected] of unsupported) {
      expect(() =>
        boundary.assertBoundaryPlatformSupport(version, securityOptions),
      ).toThrow(expected);
    }
  });

  it('rejects host bind trees containing IPC broker files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agenc-bind-input-'));
    const socketPath = join(root, 'broker.sock');
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(socketPath, resolveListen);
    });
    try {
      const boundaryUrl = new URL(
        '../scripts/run-hermetic-test-boundary.mjs',
        import.meta.url,
      );
      boundaryUrl.searchParams.set('bind-input', String(Date.now()));
      const boundary = await import(/* @vite-ignore */ boundaryUrl.href) as {
        readonly assertSafeBindTree: (root: string, label: string) => void;
      };

      expect(() => boundary.assertSafeBindTree(root, 'test')).toThrow(
        /Refusing test bind input .*broker\.sock.*\(socket\)/u,
      );
      expect(() => boundary.assertSafeBindTree('/dev/null', 'test')).toThrow(
        /Refusing test bind input "\/dev\/null" \(character-device\)/u,
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error !== undefined) rejectClose(error);
          else resolveClose();
        });
      });
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'rejects FIFO files in host bind trees',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'agenc-bind-fifo-'));
      try {
        const fifoPath = join(root, 'broker.fifo');
        const created = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
        expect(created.status, created.stderr).toBe(0);
        const boundaryUrl = new URL(
          '../scripts/run-hermetic-test-boundary.mjs',
          import.meta.url,
        );
        boundaryUrl.searchParams.set('bind-fifo', String(Date.now()));
        const boundary = await import(/* @vite-ignore */ boundaryUrl.href) as {
          readonly assertSafeBindTree: (root: string, label: string) => void;
        };

        expect(() => boundary.assertSafeBindTree(root, 'test')).toThrow(
          /Refusing test bind input .*broker\.fifo.*\(fifo\)/u,
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it('preserves exactly the documented inputs in a real design worker', () => {
    const prefix = 'reviewed-design-input';
    const designInputs = Object.fromEntries(
      [
        'AGENC_TUI_CHROME_PATH',
        'AGENC_TUI_DESIGN_BROWSER',
        'AGENC_TUI_DESIGN_BROWSER_REPORT',
        'AGENC_TUI_DESIGN_DUMP_STATE',
        'AGENC_TUI_DESIGN_DUMP_LIVE',
        'AGENC_TUI_DESIGN_EXACT_CELLS',
        'AGENC_TUI_DESIGN_HTML',
      ].map((name) => [name, `${prefix}-${name}`]),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve(runtimeRoot, 'scripts/run-hermetic-vitest.mjs'),
        '--design',
        'run',
        'tests/design-hermetic-env.test.ts',
        '--config',
        'vitest.design.config.ts',
        '--reporter=dot',
      ],
      {
        cwd: runtimeRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...designInputs,
          AGENC_TEST_DESIGN_ENV_PROBE: prefix,
          XAI_API_KEY: 'must-be-stripped',
        },
        timeout: 30_000,
      },
    );

    expect(
      result.status,
      `design env worker failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
  });
});
