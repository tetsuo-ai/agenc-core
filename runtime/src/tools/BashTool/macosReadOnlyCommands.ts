import type { ExternalCommandConfig } from '../../utils/shell/readOnlyCommandValidation.js'

// These are macOS diagnostic invocations, not blanket grants for these binaries.
// In particular sysctl, pmset, memory_pressure and ifconfig can also mutate the
// host. The surrounding shell-safety and project-path checks still apply.
const systemKeys = new Set([
  'hw.ncpu', 'hw.activecpu', 'hw.physicalcpu', 'hw.physicalcpu_max',
  'hw.logicalcpu', 'hw.logicalcpu_max', 'hw.memsize', 'hw.pagesize',
  'hw.model', 'hw.machine', 'hw.cputype', 'hw.cpusubtype',
  'machdep.cpu.brand_string', 'kern.hostname', 'kern.boottime',
  'kern.osrelease', 'kern.osversion', 'kern.ostype', 'vm.loadavg',
  'vm.swapusage', 'kern.memorystatus_vm_pressure_level',
])
const bounded = (max: number) => (value: string) =>
  /^[1-9]\d*$/.test(value) && Number(value) <= max
const oneOf = (...values: string[]) => (value: string) => values.includes(value)

function invalidOptions(
  args: string[],
  options: Record<string, (value: string) => boolean>,
  required: string[] = [],
): boolean {
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!
    const value = args[index + 1]
    if (seen.has(flag) || value === undefined || !options[flag]?.(value)) return true
    seen.add(flag)
  }
  return required.some(flag => !seen.has(flag))
}

const commands: Record<string, ExternalCommandConfig> = {
  sw_vers: {
    safeFlags: { '-productName': 'none', '-productVersion': 'none', '-buildVersion': 'none' },
    additionalCommandIsDangerousCallback: (_, args) => args.length > 1 || args.some(arg =>
      !['-productName', '-productVersion', '-buildVersion'].includes(arg)),
  },
  sysctl: {
    safeFlags: { '-n': 'none', '-h': 'none' },
    additionalCommandIsDangerousCallback: (_, args) =>
      !args.some(arg => systemKeys.has(arg)) || args.some(arg =>
        arg !== '-n' && arg !== '-h' && !systemKeys.has(arg)),
  },
  vm_stat: { safeFlags: {}, additionalCommandIsDangerousCallback: (_, args) => args.length !== 0 },
  pagesize: { safeFlags: {}, additionalCommandIsDangerousCallback: (_, args) => args.length !== 0 },
  memory_pressure: { safeFlags: {}, additionalCommandIsDangerousCallback: (_, args) => args.length !== 0 },
  mount: { safeFlags: {}, additionalCommandIsDangerousCallback: (_, args) => args.length !== 0 },
  pmset: {
    safeFlags: { '-g': 'none' },
    additionalCommandIsDangerousCallback: (_, args) => args[0] !== '-g' || args.length > 2 ||
      (args.length === 2 && !['batt', 'ps', 'custom', 'cap', 'therm', 'assertions'].includes(args[1]!)),
  },
  top: {
    safeFlags: { '-l': 'number', '-n': 'number', '-s': 'number', '-stats': 'string', '-o': 'string', '-O': 'string' },
    additionalCommandIsDangerousCallback: (_, args) => invalidOptions(args, {
      '-l': bounded(5), '-n': bounded(20), '-s': bounded(5),
      '-stats': value => value.split(',').every(oneOf('pid', 'command', 'cpu', 'mem', 'threads', 'time', 'state', 'uid', 'user')),
      '-o': oneOf('cpu', 'mem', 'pid', 'time'), '-O': oneOf('cpu', 'mem', 'pid', 'time'),
    }, ['-l']),
  },
  system_profiler: {
    safeFlags: { '-detailLevel': 'string', '-timeout': 'number', '-json': 'none', '-xml': 'none' },
    additionalCommandIsDangerousCallback: (_, args) => {
      let types = 0
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (['SPPowerDataType', 'SPHardwareDataType', 'SPSoftwareDataType', 'SPNetworkDataType'].includes(arg)) types++
        else if (arg === '-json' || arg === '-xml') continue
        else if (arg === '-detailLevel' && ['mini', 'basic'].includes(args[++i] ?? '')) continue
        else if (arg === '-timeout' && bounded(30)(args[++i] ?? '')) continue
        else return true
      }
      return types === 0
    },
  },
  ifconfig: {
    safeFlags: { '-a': 'none', '-l': 'none' },
    additionalCommandIsDangerousCallback: (_, args) => args.length > 1 ||
      args.some(arg => !/^(?:-a|-l|(?:en|lo|bridge|utun)\d+)$/.test(arg)),
  },
  ipconfig: {
    safeFlags: {},
    additionalCommandIsDangerousCallback: (_, args) =>
      args.length !== 2 || args[0] !== 'getifaddr' || !/^en\d+$/.test(args[1]!),
  },
}

// Accept only the system locations, never a project executable with the same basename.
const systemPaths: Record<string, string> = {
  sw_vers: '/usr/bin/sw_vers', sysctl: '/usr/sbin/sysctl', vm_stat: '/usr/bin/vm_stat',
  pagesize: '/usr/bin/pagesize', memory_pressure: '/usr/bin/memory_pressure',
  mount: '/sbin/mount', pmset: '/usr/bin/pmset', top: '/usr/bin/top',
  system_profiler: '/usr/sbin/system_profiler', ifconfig: '/sbin/ifconfig', ipconfig: '/usr/sbin/ipconfig',
}

export const MACOS_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  ...commands,
  ...Object.fromEntries(Object.entries(systemPaths).map(([name, path]) => [path, commands[name]!])),
}
