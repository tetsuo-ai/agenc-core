// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
/**
 * MCP add CLI subcommand
 *
 * Extracted from main.tsx to enable direct testing.
 */
import { type Command, Option } from '@commander-js/extra-typings'
import { cliError, cliOk } from '../../cli/exit.js'
import { isXaaEnabled } from '../../services/mcp/xaaIdpLogin.js'
import { runMcpAddAction } from './addAction.js'

/**
 * Registers the `mcp add` subcommand on the given Commander command.
 */
export function registerMcpAddCommand(mcp: Command): void {
  mcp
    .command('add <name> <commandOrUrl> [args...]')
    .description(
      'Add an MCP server to AgenC.\n\n' +
        'Examples:\n' +
        '  # Add HTTP server:\n' +
        '  agenc mcp add --transport http sentry https://mcp.sentry.dev/mcp\n\n' +
        '  # Add HTTP server with headers:\n' +
        '  agenc mcp add --transport http corridor https://app.corridor.dev/api/mcp --header "Authorization: Bearer ..."\n\n' +
        '  # Add stdio server with environment variables:\n' +
        '  agenc mcp add -e API_KEY=xxx my-server -- npx my-mcp-server\n\n' +
        '  # Add stdio server with subprocess flags:\n' +
        '  agenc mcp add my-server -- my-command --some-flag arg1',
    )
    .option(
      '-s, --scope <scope>',
      'Configuration scope (user or project)',
      'user',
    )
    .option(
      '-t, --transport <transport>',
      'Transport type (stdio, sse, http). Defaults to stdio if not specified.',
    )
    .option(
      '-e, --env <env...>',
      'Set environment variables (e.g. -e KEY=value)',
    )
    .option(
      '-H, --header <header...>',
      'Set WebSocket headers (e.g. -H "X-Api-Key: abc123" -H "X-Custom: value")',
    )
    .option('--client-id <clientId>', 'OAuth client ID for HTTP/SSE servers')
    .option(
      '--client-secret',
      'Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)',
    )
    .option(
      '--callback-port <port>',
      'Fixed port for OAuth callback (for servers requiring pre-registered redirect URIs)',
    )
    .helpOption('-h, --help', 'Display help for command')
    .addOption(
      new Option(
        '--xaa',
        "Enable XAA (SEP-990) for this server. Requires 'agenc mcp xaa setup' first. Also requires --client-id and --client-secret (for the MCP server's AS).",
      ).hideHelp(!isXaaEnabled()),
    )
    .action(async (name, commandOrUrl, args, options) => {
      // Commander.js handles -- natively: it consumes -- and everything after becomes args
      const actualCommand = commandOrUrl
      const actualArgs = args

      // If no name is provided, error
      if (!name) {
        cliError(
          'Error: Server name is required.\n' +
            'Usage: agenc mcp add <name> <command> [args...]',
        )
      } else if (!actualCommand) {
        cliError(
          'Error: Command is required when server name is provided.\n' +
            'Usage: agenc mcp add <name> <command> [args...]',
        )
      }

      try {
        await runMcpAddAction(name, actualCommand, actualArgs, {
          scope: options.scope,
          transport: options.transport,
          env: options.env,
          header: options.header,
          clientId: options.clientId,
          clientSecret: options.clientSecret,
          callbackPort: options.callbackPort,
          xaa: options.xaa,
        })
        cliOk()
      } catch (error) {
        cliError((error as Error).message)
      }
    })
}
