import { defineConfig } from 'tsup';

const entry = [
  'src/index.ts',
  'src/browser.ts',
  'src/operator-events.ts',
  'src/bin/agenc.ts',
  'src/bin/agenc-runtime.ts',
  'src/bin/agenc-watch.ts',
  'src/bin/daemon.ts',
];

const external = [
  '@tetsuo-ai/desktop-tool-contracts',
  '@tetsuo-ai/plugin-kit',
  'openai',
  'ollama',
  'better-sqlite3',
  'ioredis',
  'ws',
  'grammy',
  'discord.js',
  '@whiskeysockets/baileys',
  'matrix-js-sdk',
  'cheerio',
  'playwright',
  'edge-tts',
  '@modelcontextprotocol/sdk',
  // Optional peer deps that the compact subsystem (and other
  // openclaude-derived modules) reach through guarded dynamic imports.
  // Marked external so tsup does not try to bundle them at build time;
  // they will resolve (or fail gracefully) at runtime.
  '@anthropic-ai/bedrock-sdk',
  '@aws-sdk/client-bedrock',
  '@aws-sdk/client-bedrock-runtime',
  '@aws-sdk/client-sts',
  '@smithy/core',
  '@smithy/node-http-handler',
  'axios',
  'fflate',
  'google-auth-library',
  'semver',
  'sharp',
  'yaml',
];

export default defineConfig({
  entry,
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  platform: 'node',
  target: 'es2022',
  sourcemap: true,
  external,
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      'bun:bundle': './src/build/feature.ts',
    };
  },
});
