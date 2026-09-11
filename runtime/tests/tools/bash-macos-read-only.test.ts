import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { checkReadOnlyConstraints } from '../../src/tools/BashTool/readOnlyValidation.js'
import { shellCallIsGranted } from '../../src/permissions/read-only-grant.js'
import { checkPathConstraints } from '../../src/tools/BashTool/pathValidation.js'
import { createEmptyToolPermissionContext } from '../permissions/types.js'

const platform = vi.hoisted(() => ({ value: 'macos' }))
vi.mock('../../src/utils/platform.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/utils/platform.js')>(),
  getPlatform: () => platform.value,
}))
const checkReadOnly = (input: { command: string }) => checkReadOnlyConstraints(input as never, false)
const behavior = (command: string) => checkReadOnly({ command }).behavior
beforeEach(() => { platform.value = 'macos' })

const diagnostics = [
  'sw_vers', 'sw_vers -productVersion', '/usr/bin/sw_vers',
  'sysctl -n hw.ncpu hw.physicalcpu machdep.cpu.brand_string kern.hostname kern.boottime vm.loadavg',
  'sysctl -n hw.memsize', '/usr/sbin/sysctl -n vm.swapusage',
  'vm_stat', 'pagesize', 'memory_pressure', 'df -h', 'mount',
  'top -l 1 -n 5 -stats pid,command,cpu,mem',
  'top -l 2 -n 8 -stats pid,command,cpu,mem,threads -s 1',
  'pmset -g batt', 'pmset -g', 'pmset -g therm',
  'system_profiler SPPowerDataType', 'system_profiler SPPowerDataType -detailLevel mini',
  'system_profiler -json SPPowerDataType -timeout 10',
  'ifconfig', 'ifconfig -a', 'ifconfig en0', 'ipconfig getifaddr en0',
  'date && hostname && sw_vers && uptime && sysctl -n hw.memsize',
  'vm_stat && pagesize && memory_pressure',
  'pmset -g batt 2>/dev/null; pmset -g 2>/dev/null | head -40',
  'sw_vers 2>/dev/null|head -5', 'sw_vers 2>/dev/null&&uptime',
  'top -l 2 -n 8 -stats pid,command,cpu,mem,threads -s 1 2>/dev/null | tail -40',
]

describe('macOS diagnostic commands', () => {
  it.each(diagnostics)('grants %s through the real unattended shell and path gates', command => {
    expect(behavior(command), command).toBe('allow')
    expect(shellCallIsGranted('exec_command', { cmd: command }, process.cwd(),
      createEmptyToolPermissionContext({ mode: 'unattended' }), {
        checkReadOnly,
        checkPaths: (input, cwd, context) => checkPathConstraints(input as never, cwd, context),
      }), command).toEqual({ ok: true })
  })

  it.each([
    'sysctl -w kern.hostname=changed', 'sysctl kern.hostname=changed', 'sysctl -f config',
    'sysctl -n kern.hostname = changed', 'sysctl -a', 'sysctl -- -w kern.hostname=changed',
    'pmset sleepnow', 'pmset -a sleep 0', 'pmset -g batt sleepnow', 'pmset -g pslog',
    'memory_pressure -l critical', 'memory_pressure -p 1', 'memory_pressure -S -l warn',
    'mount -uw /', 'mount /dev/disk1 /mnt', 'ifconfig en0 down', 'ipconfig set en0 DHCP',
    'top', 'top -l 0', 'top -l 1 -l 0', 'top -l 999999', 'top -l 1 -s 9999',
    'vm_stat 1', 'system_profiler', 'system_profiler SPApplicationsDataType',
    'system_profiler SPPowerDataType -timeout 0', 'system_profiler SPPowerDataType -detailLevel full',
    'sw_vers > report.txt', 'sysctl -n hw.memsize; touch changed',
    'sw_vers 2>/dev/nullo; uptime', 'sw_vers 2>/dev/null\\;report; uptime',
    'sw_vers 2>"/dev/null;report"; uptime', 'sw_vers 2>/dev/null; touch changed',
    'sw_vers 2>/dev/null&>report', 'sw_vers 2>/dev/null$(echo report)',
    'sw_vers $(touch changed)', 'sw_vers $FLAGS', 'sysctl -n hw.*',
    './sw_vers', '/tmp/sw_vers', 'sudo sw_vers',
  ])('does not grant %s', command => {
    expect(behavior(command)).not.toBe('allow')
  })

  it.each(['linux', 'windows', 'wsl'])('does not apply macOS semantics on %s', value => {
    platform.value = value
    expect(behavior('sw_vers')).not.toBe('allow')
    expect(behavior('top -l 1 -n 5')).not.toBe('allow')
    expect(behavior('pmset -g batt')).not.toBe('allow')
  })

  it.skipIf(process.platform !== 'darwin')('collects real macOS diagnostics with the admitted bounded invocations', async () => {
    const exec = promisify(execFile)
    for (const [program, args, output] of [
      ['/usr/bin/sw_vers', [], /ProductVersion/],
      ['/usr/sbin/sysctl', ['-n', 'hw.memsize'], /^\d+\s*$/],
      ['/usr/bin/vm_stat', [], /Pages free/],
      ['/usr/bin/pmset', ['-g', 'batt'], /Now drawing from/],
      ['/usr/bin/top', ['-l', '1', '-n', '5', '-stats', 'pid,command,cpu,mem'], /Processes:/],
    ] as const) {
      const command = [program, ...args].join(' ')
      expect(behavior(command), command).toBe('allow')
      const { stdout } = await exec(program, [...args], {
        timeout: 10_000, maxBuffer: 128 * 1024,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
      })
      expect(stdout).toMatch(output)
    }
  }, 30_000)
})
