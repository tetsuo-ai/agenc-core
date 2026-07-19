import React from 'react'
import { describe, expect, test } from 'vitest'

import type { PermissionMode } from '../../../src/permissions/types.js'
import { Box, Text } from '../../../src/tui/ink.js'
import {
  ApprovalCard,
  BrandCells,
  ChatBody,
  MenuModal,
  ModePill,
  ModeSwitcher,
  Msg,
  PlanList,
  PlanModeBanner,
  PromptChrome,
  ProtocolEvent,
  SlashPalette,
  StatusSegment,
  TaskInFlightCard,
  TerminalFrame,
  Tool,
  WelcomeColdPanel,
} from '../../../src/tui/components/v2/primitives.js'
import { renderToString } from '../../../src/utils/staticRender.js'

describe('v2 primitives coverage swarm row 065', () => {
  test('renders narrow and wide terminal frame chrome branches', async () => {
    const narrow = await renderToString(
      <TerminalFrame
        title="agenc ~ compact"
        tabLabel="hidden-tab"
        tabStatus="warn"
        permissionMode={'bubble' as PermissionMode}
        taskPda="hidden-task"
        promptPlaceholder="say something"
        statusLeft={[<StatusSegment key="stake" label="stake" value="18" separator={false} />]}
        columns={54}
        minHeight={8}
      >
        <ChatBody>
          <Text>narrow body</Text>
        </ChatBody>
      </TerminalFrame>,
      { columns: 54, rows: 12 },
    )

    expect(narrow).toContain('~/compact')
    expect(narrow).toContain('mode · bubble')
    expect(narrow).toContain('narrow body')
    expect(narrow).toContain('say something')
    expect(narrow).not.toContain('hidden-tab')
    expect(narrow).not.toContain('hidden-task')

    const wide = await renderToString(
      <TerminalFrame
        title="session"
        tabLabel="pending-tab"
        tabStatus="pending"
        permissionMode="bypassPermissions"
        taskPda="6qTask"
        bodyOverlay={<StatusSegment label="cost" value="0.20" />}
        bodyOverlayX={4}
        promptOverlay={<PlanModeBanner title="hold" body="read only until approved" />}
        contextLeft="ctx-left"
        contextRight={<Text>ctx-right</Text>}
        promptText="cargo test"
        promptHint="hint right"
        shellMode={true}
        paused={true}
        statusVariant="neutral"
        statusLeft={[
          'raw-left',
          <StatusSegment key="stake" label="stake" value="18" gapAfter={0} />,
          <StatusSegment key="cost" label="cost" value="0.1" />,
        ]}
        statusRight={[<StatusSegment key="net" label="net" value="localnet" />]}
        columns={148}
        minHeight={14}
      >
        <ChatBody centered={true} maxWidth={60}>
          <Text>wide body</Text>
        </ChatBody>
      </TerminalFrame>,
      { columns: 148, rows: 18 },
    )

    expect(wide).toContain('pending-tab')
    expect(wide).toContain('6qTask')
    expect(wide).toContain('wide body')
    expect(wide).toContain('COST 0.20')
    expect(wide).toContain('HOLD')
    expect(wide).toContain('ctx-left')
    expect(wide).toContain('ctx-right')
    expect(wide).toContain('$')
    expect(wide).toContain('cargo test')
    expect(wide).toContain('hint right')
    expect(wide).toContain('localnet')
  })

  test('renders cards, lists, tools, and approval variants', async () => {
    const output = await renderToString(
      <Box flexDirection="column">
        <BrandCells columns={1} rows={1} />
        <ModePill mode={'unknown-mode' as PermissionMode} />
        <ModeSwitcher currentMode="acceptEdits" spacious={true} />
        <WelcomeColdPanel
          workspace="/tmp/agenc"
          model="row065"
          lastSession="coverage"
          recentSessions={[
            { keyName: '1', title: 'runtime coverage', detail: 'row065' },
          ]}
        />
        <TaskInFlightCard
          taskId="#65"
          title="cover v2 primitives"
          taskPda="row065-pda"
          escrow="0.65"
          deadline="deadline now"
          planItems={[
            { state: 'done', text: 'read source' },
            { state: 'active', text: 'write focused tests' },
            { state: 'pending', text: 'run target' },
            { state: 'failed', text: 'report source issue' },
          ]}
        />
        <Msg role="system" label="notice">{['array ', 65]}</Msg>
        <Msg role="user" label="operator" time="12:34">{6500}</Msg>
        <Tool kind="edit" state="queued" args="file.ts" />
        <Tool kind="grep" state="running" args="pattern: row065" time="1s" />
        <Tool
          kind="bash"
          state="failed"
          args="npm test"
          result="exit 1"
          expanded={true}
          detail={<Text>stderr detail</Text>}
        />
        <Tool kind="stake" args="stake account" result="ok" />
        <PlanList
          title="mixed plan"
          gapAfterActive={true}
          items={[
            { state: 'done', text: 'completed row' },
            { state: 'active', text: 'active row' },
            { state: 'pending', text: 'pending row' },
            { state: 'failed', text: 'failed row' },
          ]}
        />
        <PromptChrome paused={true} placeholder="paused placeholder" hint="paused hint" />
        <ApprovalCard
          risk="low"
          title="local approval"
          command="npm run lint"
          facts={[
            { label: 'network', value: 'localnet' },
            { label: 'cost', value: '0.01' },
          ]}
          note="safe local command"
          confirmLabel="approve"
          requestId="call_swarm065_low"
        />
        <ApprovalCard
          risk="high"
          title="settle approval"
          command="settle_task --mainnet"
          facts={[
            { label: 'net', value: 'mainnet-beta' },
            { label: 'risk', value: 'high' },
          ]}
          confirmLabel="type yes"
          requireTypedConfirmation={true}
          requestId="call_swarm065_high"
        />
      </Box>,
      { columns: 132, rows: 40 },
    )

    expect(output).toContain('mode · default')
    expect(output).toContain('current · acceptEdits')
    expect(output).toContain('row065')
    expect(output).toContain('/tmp/agenc')
    expect(output).toContain('coverage')
    expect(output).toContain('#65')
    expect(output).toContain('CHECKPOINTED PLAN')
    expect(output).toContain('NOTICE')
    expect(output).toContain('array 65')
    expect(output).toContain('OPERATOR')
    expect(output).toContain('6500')
    expect(output).toContain('Edit')
    expect(output).toContain('Grep')
    expect(output).toContain('exit 1')
    expect(output).toContain('stderr detail')
    expect(output).toContain('MIXED PLAN')
    expect(output).toContain('paused placeholder')
    expect(output).toContain('req 0x47a3')
    expect(output).toContain('edit command')
    expect(output).toContain('req 0x9c14')
    expect(output).toContain('confirmation required')
  })

  test('windows menu rows with previews and clamps empty menu state', async () => {
    const rows = [
      { status: 'new', name: 'alpha' },
      { status: 'run', name: 'beta' },
      { status: 'done', name: 'gamma' },
    ]

    const previewOutput = await renderToString(
      <MenuModal
        title="preview"
        summary="summary text"
        headerRight="right hint"
        columns={[8, 10]}
        headers={['status', 'name']}
        items={rows}
        activeIndex={99}
        preview={<Text>preview side</Text>}
        previewWidth="35%"
        footer={[{ keyName: 'j', label: 'down' }]}
        hint="footer hint"
        omitTopBorder={true}
        paddingX={0}
        columnGap={0}
        modalMinHeight={20}
        rowMinHeight={2}
        renderRow={(row, index, active) => [
          <Text key="status">{active ? `>${row.status}` : row.status}</Text>,
          <Text key="name">{`${index}:${row.name}`}</Text>,
        ]}
      />,
      { columns: 80, rows: 12 },
    )

    expect(previewOutput).toContain('SUMMARY TEXT')
    expect(previewOutput).toContain('right hint')
    expect(previewOutput).toContain('>done')
    expect(previewOutput).toContain('2:gamma')
    expect(previewOutput).toContain('preview side')
    expect(previewOutput).toContain('footer hint')
    expect(previewOutput).toContain('0:alpha')

    const emptyOutput = await renderToString(
      <MenuModal
        title="empty"
        columns={[6]}
        headers={['name']}
        items={[]}
        activeIndex={-5}
        footer={[]}
        renderRow={() => [<Text key="unused">unused</Text>]}
      />,
      { columns: 80 },
    )

    expect(emptyOutput).toContain('EMPTY')
    expect(emptyOutput).toContain('name')
    expect(emptyOutput).toContain('esc to close')
    expect(emptyOutput).not.toContain('unused')
    expect(emptyOutput).not.toContain('scroll')
  })

  test('renders slash palette overflow and protocol event variants', async () => {
    const output = await renderToString(
      <Box flexDirection="column">
        <SlashPalette
          activeCommand="/delegate"
          totalCount={5}
          maxVisible={3}
          headerRightInset={0}
          items={[
            { command: '/delegate', args: '<agent>', description: 'agenc · delegate work' },
            { command: '/claim', args: '<task>', description: 'claim marketplace work' },
            { command: '/settle', args: '<task>', description: 'settle escrow' },
            { command: '/stake', args: '<amount>', description: 'stake identity' },
          ]}
        />
        <SlashPalette
          activeCommand="/offset"
          totalCount={1}
          maxVisible={1}
          offsetTop={2}
          headerRightInset={0}
          items={[
            { command: '/offset', args: '', description: 'offset branch' },
          ]}
        />
        <ProtocolEvent
          kind="settle"
          title="settled task"
          body="settled body"
          facts={[{ label: 'proof', value: 'hash-065' }]}
        />
        <ProtocolEvent kind="slash" title="slash event" body={<Text>slash body</Text>} />
        <ProtocolEvent kind="stake" title="stake event" body={['stake ', 'body']} />
        <ProtocolEvent
          kind="claim"
          title="claim event"
          body="claim body"
          facts={[{ label: 'task', value: '#65' }]}
        />
      </Box>,
      { columns: 100, rows: 24 },
    )

    expect(output).toContain('slash commands · 5')
    expect(output).toContain('/delegate')
    expect(output).toContain('delegate work')
    expect(output).not.toContain('agenc · delegate work')
    expect(output).toContain('+ 2')
    expect(output).toContain('more ·')
    expect(output).toContain('settled task')
    expect(output).toContain('PROOF')
    expect(output).toContain('hash-065')
    expect(output).toContain('slash event')
    expect(output).toContain('slash body')
    expect(output).toContain('stake event')
    expect(output).toContain('stake body')
    expect(output).toContain('claim event')
    expect(output).toContain('#65')
  })
})
