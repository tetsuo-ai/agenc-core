#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHermeticRunRoot } from '../tests/helpers/hermetic-env.mjs'

export const PINNED_NODE_IMAGE =
  'node:25.9.0-bookworm@sha256:78839ac448c23517f8eab2e8f7943d9b4f73979eb7f8bed2c73dbf72ff869e7b'
const DOCKER_HOST = 'unix:///var/run/docker.sock'
const BOUNDARY_EXIT = 97
const MINIMUM_DOCKER_VERSION = Object.freeze([25, 0])
const MINIMUM_DOCKER_API_VERSION = Object.freeze([1, 44])
const MINIMUM_LINUX_VERSION = Object.freeze([5, 12])
const BOUNDARY_ACCOUNT_HOME = '/tmp/agenc-boundary-home'
export const DOCKER_SECCOMP_PROFILE_SHA256 =
  'de1f5327ca42b80be02daba8d39c0d087a530dc3c16f7028170fe068c9d66e61'
const RIPGREP_SHA256 = Object.freeze({
  arm64: 'e152ea689d6e8420357e592f0d8253b96476c164118ca3e6e13074fa1705ddda',
  x64: '193906679498de4d939345b937fa24e0e69a03c244bd70c859f5e41232713f21',
})
const RIPGREP_PLATFORM_PACKAGES = Object.freeze({
  arm64: '@vscode/ripgrep-linux-arm64',
  x64: '@vscode/ripgrep-linux-x64',
})
const runtimeRoot = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))))
const repositoryRoot = realpathSync(join(runtimeRoot, '..'))
const observerSource = join(runtimeRoot, 'scripts', 'hermetic-network-boundary.c')
const dockerSeccompSource = join(
  runtimeRoot,
  'scripts',
  'hermetic-docker-seccomp.json',
)
const observerBinary = '/boundary/agenc-network-boundary'
const requestedArgs = process.argv.slice(2)
if (requestedArgs.length === 0) requestedArgs.push('run')

let activeContainer
let activeDockerChild
let activeDockerSeccompProfile
let activePasswdFile
let activeRipgrepBinary
let interruptedSignal

const require = createRequire(import.meta.url)

function daemonBindInputScanner() {
  'use strict'
  const {
    closeSync,
    constants: fsConstants,
    fstatSync: fstat,
    lstatSync: lstat,
    openSync: open,
    opendirSync: opendir,
  } = require('node:fs')
  const { join: joinPath } = require('node:path')

  function specialKind(metadata) {
    if (metadata.isSocket()) return 'socket'
    if (metadata.isFIFO()) return 'fifo'
    if (metadata.isBlockDevice()) return 'block-device'
    if (metadata.isCharacterDevice()) return 'character-device'
    return undefined
  }

  function refuse(path, kind) {
    throw new Error(`refusing bind input ${JSON.stringify(path)} (${kind})`)
  }

  function scanRoot(root) {
    const metadata = lstat(root)
    const rootKind = specialKind(metadata)
    if (rootKind !== undefined) refuse(root, rootKind)
    if (metadata.isFile()) return
    if (!metadata.isDirectory()) refuse(root, 'unsupported-root-type')
    const rootDescriptor = open(
      root,
      fsConstants.O_RDONLY |
        fsConstants.O_CLOEXEC |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW,
    )
    const seen = new Set()
    function scanDirectory(descriptor, displayPath) {
      const opened = fstat(descriptor)
      const identity = `${opened.dev}:${opened.ino}`
      if (seen.has(identity)) return
      seen.add(identity)
      const descriptorPath = `/proc/self/fd/${descriptor}`
      const directory = opendir(descriptorPath)
      try {
        for (;;) {
          const entry = directory.readSync()
          if (entry === null) break
          const candidate = joinPath(displayPath, entry.name)
          const descriptorCandidate = joinPath(descriptorPath, entry.name)
          const candidateMetadata = lstat(descriptorCandidate)
          if (candidateMetadata.isDirectory()) {
            const child = open(
              descriptorCandidate,
              fsConstants.O_RDONLY |
                fsConstants.O_CLOEXEC |
                fsConstants.O_DIRECTORY |
                fsConstants.O_NOFOLLOW,
            )
            try {
              scanDirectory(child, candidate)
            } finally {
              closeSync(child)
            }
            continue
          }
          if (candidateMetadata.isFile() || candidateMetadata.isSymbolicLink()) {
            continue
          }
          refuse(
            candidate,
            specialKind(candidateMetadata) ?? 'unknown-special-file',
          )
        }
      } finally {
        directory.closeSync()
      }
    }
    try {
      scanDirectory(rootDescriptor, root)
    } finally {
      closeSync(rootDescriptor)
    }
  }

  try {
    for (const root of process.argv.slice(1)) scanRoot(root)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`AGENC_DAEMON_BIND_SCAN_ERROR ${JSON.stringify(message)}\n`)
    process.exitCode = 65
  }
}

const DAEMON_BIND_INPUT_SCANNER = `(${daemonBindInputScanner.toString()})()`
const DAEMON_SOCKET_SCANNER_CANARY = String.raw`
const { spawnSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const { createServer } = require('node:net')
const root = '/tmp/agenc-daemon-socket-scan'
mkdirSync(root, { recursive: true })
const server = createServer()
server.once('error', error => {
  process.stderr.write(String(error) + '\n')
  process.exitCode = 70
})
server.listen(root + '/broker.sock', () => {
  const result = spawnSync(process.execPath, ['-e', process.argv[1], root], {
    encoding: 'utf8',
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  process.exit(result.status ?? 70)
})
`

export function resolveGitCommonDirectory() {
  const result = spawnSync(
    'git',
    [
      '-C',
      repositoryRoot,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ],
    {
      encoding: 'utf8',
      env: {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        HOME: '/tmp/agenc-hermetic-git-home',
        LANG: 'C',
        LC_ALL: 'C',
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (result.status !== 0) {
    throw new Error(
      `Hermetic tests require a Git checkout\n${String(result.stderr ?? '').trim()}`,
    )
  }
  const candidate = String(result.stdout ?? '').trim()
  if (!isAbsolute(candidate)) {
    throw new Error(`Git returned a non-absolute common directory: ${candidate}`)
  }
  return realpathSync(candidate)
}

export const gitCommonDirectory = resolveGitCommonDirectory()

function specialBindEntryKind(metadata) {
  if (metadata.isSocket()) return 'socket'
  if (metadata.isFIFO()) return 'fifo'
  if (metadata.isBlockDevice()) return 'block-device'
  if (metadata.isCharacterDevice()) return 'character-device'
  return undefined
}

export function assertSafeBindTree(root, label) {
  const rootMetadata = lstatSync(root)
  const rootKind = specialBindEntryKind(rootMetadata)
  if (rootKind !== undefined) {
    throw new Error(
      `Refusing ${label} bind input ${JSON.stringify(root)} (${rootKind})`,
    )
  }
  if (rootMetadata.isFile()) return
  if (!rootMetadata.isDirectory()) {
    throw new Error(
      `Refusing ${label} bind input ${JSON.stringify(root)} (unsupported-root-type)`,
    )
  }

  const seenDirectories = new Set()
  const scanDirectory = (descriptor, displayPath) => {
    const openedMetadata = fstatSync(descriptor)
    const identity = `${openedMetadata.dev}:${openedMetadata.ino}`
    if (seenDirectories.has(identity)) return
    seenDirectories.add(identity)
    const descriptorPath = `/proc/self/fd/${descriptor}`
    const directory = opendirSync(descriptorPath)
    try {
      for (;;) {
        const entry = directory.readSync()
        if (entry === null) break
        const candidate = join(displayPath, entry.name)
        const descriptorCandidate = join(descriptorPath, entry.name)
        const metadata = lstatSync(descriptorCandidate)
        if (metadata.isDirectory()) {
          let childDescriptor
          try {
            childDescriptor = openSync(
              descriptorCandidate,
              constants.O_RDONLY |
                constants.O_CLOEXEC |
                constants.O_DIRECTORY |
                constants.O_NOFOLLOW,
            )
          } catch (error) {
            throw new Error(
              `Refusing unstable ${label} bind directory ${JSON.stringify(candidate)}`,
              { cause: error },
            )
          }
          try {
            scanDirectory(childDescriptor, candidate)
          } finally {
            closeSync(childDescriptor)
          }
          continue
        }
        if (metadata.isFile() || metadata.isSymbolicLink()) continue
        const kind = specialBindEntryKind(metadata) ?? 'unknown-special-file'
        throw new Error(
          `Refusing ${label} bind input ${JSON.stringify(candidate)} (${kind})`,
        )
      }
    } finally {
      directory.closeSync()
    }
  }
  let rootDescriptor
  try {
    rootDescriptor = openSync(
      root,
      constants.O_RDONLY |
        constants.O_CLOEXEC |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW,
    )
  } catch (error) {
    throw new Error(
      `Refusing unstable ${label} bind root ${JSON.stringify(root)}`,
      { cause: error },
    )
  }
  try {
    scanDirectory(rootDescriptor, root)
  } finally {
    closeSync(rootDescriptor)
  }
}

export function resolveBundledRipgrepPath(
  arch = process.arch,
  resolveModule = specifier => require.resolve(specifier),
) {
  const platformPackage = RIPGREP_PLATFORM_PACKAGES[arch]
  if (platformPackage === undefined) {
    throw new Error(`Unsupported hermetic ripgrep architecture: ${arch}`)
  }
  return resolveModule(`${platformPackage}/bin/rg`)
}

function snapshotBundledRipgrep(snapshotRoot) {
  let rgPath
  try {
    rgPath = resolveBundledRipgrepPath()
  } catch (error) {
    throw new Error(
      'Hermetic tests require the pinned @vscode/ripgrep dev dependency. Run npm install before npm test.',
      { cause: error },
    )
  }
  const binary = realpathSync(rgPath)
  if (!isWithin(repositoryRoot, binary)) {
    throw new Error(`Refusing ripgrep outside the repository: ${binary}`)
  }
  const descriptor = openSync(
    binary,
    constants.O_RDONLY | constants.O_CLOEXEC | constants.O_NOFOLLOW,
  )
  let bytes
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Pinned ripgrep is not a regular file: ${binary}`)
    }
    bytes = readFileSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  const expected = RIPGREP_SHA256[process.arch]
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) {
    throw new Error(
      `Pinned ripgrep integrity check failed: expected ${expected}, received ${actual}`,
    )
  }
  const snapshot = join(snapshotRoot, 'rg')
  writeFileSync(snapshot, bytes, { flag: 'wx', mode: 0o500 })
  return snapshot
}

function snapshotDockerSeccompProfile(snapshotRoot) {
  const source = realpathSync(dockerSeccompSource)
  if (!isWithin(repositoryRoot, source)) {
    throw new Error(`Refusing Docker seccomp profile outside the repository: ${source}`)
  }
  const descriptor = openSync(
    source,
    constants.O_RDONLY | constants.O_CLOEXEC | constants.O_NOFOLLOW,
  )
  let bytes
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Pinned Docker seccomp profile is not a regular file: ${source}`)
    }
    bytes = readFileSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== DOCKER_SECCOMP_PROFILE_SHA256) {
    throw new Error(
      `Pinned Docker seccomp profile integrity check failed: expected ${DOCKER_SECCOMP_PROFILE_SHA256}, received ${actual}`,
    )
  }
  let profile
  try {
    profile = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error('Pinned Docker seccomp profile is not valid JSON', {
      cause: error,
    })
  }
  if (profile?.defaultAction !== 'SCMP_ACT_ERRNO') {
    throw new Error('Pinned Docker seccomp profile must fail closed by default')
  }
  const snapshot = join(snapshotRoot, 'docker-seccomp.json')
  writeFileSync(snapshot, bytes, { flag: 'wx', mode: 0o400 })
  return snapshot
}

export function boundaryPasswdEntry(uid, gid) {
  if (
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    !Number.isSafeInteger(gid) ||
    gid < 0
  ) {
    throw new Error('Hermetic account UID and GID must be non-negative integers')
  }
  return `agenc-boundary:x:${uid}:${gid}:AgenC hermetic test:${BOUNDARY_ACCOUNT_HOME}:/usr/sbin/nologin\n`
}

function snapshotBoundaryPasswd(snapshotRoot) {
  const passwd = join(snapshotRoot, 'passwd')
  writeFileSync(passwd, boundaryPasswdEntry(process.getuid(), process.getgid()), {
    flag: 'wx',
    mode: 0o400,
  })
  return passwd
}

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate)
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  )
}

function bindMount(
  source,
  destination,
  { readonly = true, recursiveReadonly = false } = {},
) {
  for (const value of [source, destination]) {
    if (value.includes(',') || value.includes('\n') || value.includes('\0')) {
      throw new Error(
        `Docker bind-mount path is not representable safely: ${value}`,
      )
    }
  }
  return `type=bind,src=${source},dst=${destination}${readonly ? ',readonly' : ''}${readonly && recursiveReadonly ? ',bind-recursive=readonly' : ''},bind-propagation=rprivate`
}

function dockerEnvironment(supervisorRoot) {
  return {
    HOME: supervisorRoot,
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  }
}

function dockerCommand(supervisorRoot, args) {
  return [
    '--host',
    DOCKER_HOST,
    '--config',
    join(supervisorRoot, 'docker-config'),
    ...args,
  ]
}

function removeContainer(supervisorRoot, name) {
  if (name === undefined) return
  spawnSync(
    'docker',
    dockerCommand(supervisorRoot, ['rm', '--force', name]),
    {
      encoding: 'utf8',
      env: dockerEnvironment(supervisorRoot),
      stdio: 'ignore',
    },
  )
}

function installSignalHandlers(supervisorRoot) {
  const handlers = new Map()
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      interruptedSignal = signal
      removeContainer(supervisorRoot, activeContainer)
      activeDockerChild?.kill(signal)
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler)
    }
  }
}

function commonContainerArgs(name, boundaryMountMode = 'readonly') {
  const uid = process.getuid()
  const gid = process.getgid()
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
  const gitCommonMount = isWithin(repositoryRoot, gitCommonDirectory)
    ? []
    : [
        '--mount',
        bindMount(gitCommonDirectory, gitCommonDirectory, {
          recursiveReadonly: true,
        }),
      ]
  if (activeRipgrepBinary === undefined) {
    throw new Error('Hermetic ripgrep input was not initialized')
  }
  if (activeDockerSeccompProfile === undefined) {
    throw new Error('Hermetic Docker seccomp input was not initialized')
  }
  if (activePasswdFile === undefined) {
    throw new Error('Hermetic account identity input was not initialized')
  }
  return [
    'run',
    '--rm',
    '--pull=never',
    '--platform',
    platform,
    '--name',
    name,
    '--network=none',
    '--dns=192.0.2.53',
    '--ipc=private',
    '--cgroupns=private',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true',
    `--security-opt=seccomp=${activeDockerSeccompProfile}`,
    '--pids-limit=8192',
    '--ulimit=core=0:0',
    '--stop-timeout=5',
    '--read-only',
    '--hostname=agenc-hermetic-test',
    '--user',
    `${uid}:${gid}`,
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,exec,size=2g,mode=1777',
    '--tmpfs',
    '/run:rw,nosuid,nodev,noexec,size=16m,mode=755',
    '--tmpfs',
    `${join(runtimeRoot, 'node_modules', '.vite-temp')}:rw,nosuid,nodev,size=128m,mode=1777`,
    '--mount',
    bindMount(repositoryRoot, repositoryRoot, { recursiveReadonly: true }),
    ...gitCommonMount,
    '--mount',
    bindMount(activeRipgrepBinary, '/usr/local/bin/rg'),
    '--mount',
    bindMount(activePasswdFile, '/etc/passwd'),
    '--mount',
    bindMount(activeBoundaryRoot, '/boundary', {
      readonly: boundaryMountMode === 'readonly',
    }),
    '--env',
    'AGENC_TEST_OS_BOUNDARY=1',
    '--env',
    'ALL_PROXY=',
    '--env',
    'HOME=/tmp/agenc-boundary-home',
    '--env',
    'HTTPS_PROXY=',
    '--env',
    'HTTP_PROXY=',
    '--env',
    'LANG=C.UTF-8',
    '--env',
    'LC_ALL=C.UTF-8',
    '--env',
    'NODE_ENV=test',
    '--env',
    'NODE_OPTIONS=',
    '--env',
    'NPM_CONFIG_OFFLINE=true',
    '--env',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    '--env',
    'TZ=UTC',
    `--workdir=${runtimeRoot}`,
    PINNED_NODE_IMAGE,
  ]
}

async function runDocker(supervisorRoot, args, options = {}) {
  const nameIndex = args.indexOf('--name')
  const name = nameIndex === -1 ? undefined : args[nameIndex + 1]
  activeContainer = name
  const capture = options.capture === true
  const child = spawn('docker', dockerCommand(supervisorRoot, args), {
    env: dockerEnvironment(supervisorRoot),
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  activeDockerChild = child
  let stdout = ''
  let stderr = ''
  if (capture) {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
  }
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    return { ...result, stderr, stdout }
  } finally {
    activeDockerChild = undefined
    activeContainer = undefined
    removeContainer(supervisorRoot, name)
  }
}

function requirePinnedImage(supervisorRoot) {
  const result = spawnSync(
    'docker',
    dockerCommand(supervisorRoot, ['image', 'inspect', PINNED_NODE_IMAGE]),
    {
      encoding: 'utf8',
      env: dockerEnvironment(supervisorRoot),
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  if (result.status === 0) return
  throw new Error(
    [
      `Hermetic tests require a local Docker daemon at ${DOCKER_HOST}`,
      `and the pinned image ${PINNED_NODE_IMAGE}.`,
      'Provision that exact digest outside npm test; the test command never pulls images.',
      String(result.stderr ?? '').trim(),
    ].filter(Boolean).join('\n'),
  )
}

function readDockerJson(supervisorRoot, args, label) {
  const result = spawnSync('docker', dockerCommand(supervisorRoot, args), {
    encoding: 'utf8',
    env: dockerEnvironment(supervisorRoot),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(
      [
        `Could not inspect ${label} through ${DOCKER_HOST}`,
        String(result.stderr ?? '').trim(),
      ].filter(Boolean).join('\n'),
    )
  }
  try {
    return JSON.parse(String(result.stdout ?? ''))
  } catch (error) {
    throw new Error(`Docker returned invalid JSON for ${label}`, { cause: error })
  }
}

function parseVersionPair(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`Docker did not report ${label}`)
  }
  const match = /^(\d+)\.(\d+)(?:\D|$)/u.exec(value)
  if (match === null) {
    throw new Error(`Docker reported an invalid ${label}: ${JSON.stringify(value)}`)
  }
  return [Number(match[1]), Number(match[2])]
}

function isVersionAtLeast(actual, minimum) {
  return actual[0] > minimum[0] ||
    (actual[0] === minimum[0] && actual[1] >= minimum[1])
}

function requireMinimumVersion(value, label, minimum) {
  const actual = parseVersionPair(value, label)
  if (!isVersionAtLeast(actual, minimum)) {
    throw new Error(
      `Hermetic tests require ${label} ${minimum.join('.')} or newer; received ${value}`,
    )
  }
}

export function assertBoundaryPlatformSupport(version, securityOptions) {
  requireMinimumVersion(
    version?.Client?.Version,
    'Docker CLI',
    MINIMUM_DOCKER_VERSION,
  )
  requireMinimumVersion(
    version?.Client?.ApiVersion,
    'Docker client API',
    MINIMUM_DOCKER_API_VERSION,
  )
  requireMinimumVersion(
    version?.Server?.Version,
    'Docker Engine',
    MINIMUM_DOCKER_VERSION,
  )
  requireMinimumVersion(
    version?.Server?.ApiVersion,
    'Docker Engine API',
    MINIMUM_DOCKER_API_VERSION,
  )
  if (version?.Server?.Os !== 'linux') {
    throw new Error(
      `Hermetic tests require a Linux Docker Engine; received ${JSON.stringify(version?.Server?.Os)}`,
    )
  }
  requireMinimumVersion(
    version?.Server?.KernelVersion,
    'Linux kernel',
    MINIMUM_LINUX_VERSION,
  )
  if (
    !Array.isArray(securityOptions) ||
    !securityOptions.some(option =>
      typeof option === 'string' && option.startsWith('name=seccomp'))
  ) {
    throw new Error(
      'Hermetic tests require a Docker Engine with Linux seccomp enabled',
    )
  }
}

function requireBoundaryPlatform(supervisorRoot) {
  const version = readDockerJson(
    supervisorRoot,
    ['version', '--format', '{{json .}}'],
    'Docker versions',
  )
  const securityOptions = readDockerJson(
    supervisorRoot,
    ['info', '--format', '{{json .SecurityOptions}}'],
    'Docker security options',
  )
  assertBoundaryPlatformSupport(version, securityOptions)
}

async function verifyDaemonResolvedBindInputs(supervisorRoot) {
  const roots = [repositoryRoot]
  if (!isWithin(repositoryRoot, gitCommonDirectory)) {
    roots.push(gitCommonDirectory)
  }
  const name = containerName('bind-inputs')
  const result = await runDocker(
    supervisorRoot,
    [
      ...commonContainerArgs(name),
      'node',
      '-e',
      DAEMON_BIND_INPUT_SCANNER,
      ...roots,
    ],
    { capture: true },
  )
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      [
        'Hermetic test bind-input preflight failed',
        `received exit ${String(result.code)} signal ${String(result.signal)}`,
        `${result.stdout}${result.stderr}`.trim(),
      ].filter(Boolean).join('\n'),
    )
  }
}

async function verifyDaemonBindInputScannerCanaries(supervisorRoot) {
  const canaries = [
    {
      command: [
        'sh',
        '-c',
        'mkdir /tmp/agenc-daemon-fifo-scan && mkfifo /tmp/agenc-daemon-fifo-scan/broker.fifo && exec node -e "$1" /tmp/agenc-daemon-fifo-scan',
        'agenc-daemon-fifo-scan',
        DAEMON_BIND_INPUT_SCANNER,
      ],
      evidence: ['(fifo)', 'broker.fifo'],
      label: 'fifo',
    },
    {
      command: [
        'node',
        '-e',
        DAEMON_SOCKET_SCANNER_CANARY,
        DAEMON_BIND_INPUT_SCANNER,
      ],
      evidence: ['(socket)', 'broker.sock'],
      label: 'socket',
    },
  ]
  for (const canary of canaries) {
    const name = containerName(`bind-scan-${canary.label}`)
    const result = await runDocker(
      supervisorRoot,
      [...commonContainerArgs(name), ...canary.command],
      { capture: true },
    )
    const evidence = `${result.stdout}\n${result.stderr}`
    if (
      result.code !== 65 ||
      result.signal !== null ||
      !evidence.includes('AGENC_DAEMON_BIND_SCAN_ERROR') ||
      !canary.evidence.every(item => evidence.includes(item))
    ) {
      throw new Error(
        [
          `Hermetic daemon bind-input scanner canary failed: ${canary.label}`,
          `expected exit 65 and evidence ${canary.evidence.join(', ')}`,
          `received exit ${String(result.code)} signal ${String(result.signal)}`,
          evidence.trim(),
        ].join('\n'),
      )
    }
  }
}

async function compileObserver(supervisorRoot) {
  const name = containerName('compile')
  const result = await runDocker(
    supervisorRoot,
    [
      ...commonContainerArgs(name, 'rw'),
      'cc',
      '-std=c11',
      '-O2',
      '-D_FORTIFY_SOURCE=2',
      '-fPIE',
      '-fstack-protector-strong',
      '-Wall',
      '-Wextra',
      '-Werror',
      observerSource,
      '-Wl,-z,relro,-z,now',
      '-pie',
      '-o',
      observerBinary,
    ],
    { capture: true },
  )
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      `Could not compile the hermetic OS boundary\n${result.stdout}${result.stderr}`,
    )
  }
}

const canaries = [
  [
    '--native-canary',
    [
      'syscall=connect target=192.0.2.1',
      'syscall=sendto target=192.0.2.53',
    ],
  ],
  ['--clone-untraced-canary', ['syscall=clone target=CLONE_UNTRACED']],
  ['--seccomp-replacement-canary', ['target=filter-replacement-attempt']],
  ['--vsock-canary', ['target=forbidden-network-channel']],
  ['--unix-broker-canary', ['target=unix-path-outside-private-tmp']],
  ['--unix-traversal-canary', ['target=unix-path-traversal']],
  ['--unix-symlink-canary', ['target=unix-path-symlink']],
  ['--unix-noncanonical-canary', ['target=unix-path-noncanonical']],
]
const allowedCanaries = ['--unix-private-canary']
const exitStatusCanaries = [['--sigtrap-canary', 133]]

async function verifyObserver(supervisorRoot) {
  for (const [mode, expectedEvidence] of canaries) {
    const name = containerName(`canary-${mode.slice(2, 14)}`)
    const result = await runDocker(
      supervisorRoot,
      [
        ...commonContainerArgs(name),
        observerBinary,
        observerBinary,
        mode,
      ],
      { capture: true },
    )
    const evidence = `${result.stdout}\n${result.stderr}`
    if (
      result.code !== BOUNDARY_EXIT ||
      result.signal !== null ||
      !evidence.includes('AGENC_OS_NETWORK_BOUNDARY_VIOLATION') ||
      !expectedEvidence.every(item => evidence.includes(item))
    ) {
      throw new Error(
        [
          `Hermetic OS boundary canary failed: ${mode}`,
          `expected exit ${BOUNDARY_EXIT} and evidence ${expectedEvidence.join(', ')}`,
          `received exit ${String(result.code)} signal ${String(result.signal)}`,
          evidence.trim(),
        ].join('\n'),
      )
    }
  }
  for (const mode of allowedCanaries) {
    const name = containerName(`canary-${mode.slice(2, 14)}`)
    const result = await runDocker(
      supervisorRoot,
      [
        ...commonContainerArgs(name),
        observerBinary,
        observerBinary,
        mode,
      ],
      { capture: true },
    )
    const evidence = `${result.stdout}\n${result.stderr}`
    if (
      result.code !== 0 ||
      result.signal !== null ||
      evidence.includes('AGENC_OS_NETWORK_BOUNDARY_VIOLATION')
    ) {
      throw new Error(
        [
          `Hermetic OS boundary allowed-path canary failed: ${mode}`,
          'expected exit 0 with no violation evidence',
          `received exit ${String(result.code)} signal ${String(result.signal)}`,
          evidence.trim(),
        ].join('\n'),
      )
    }
  }
  for (const [mode, expectedExit] of exitStatusCanaries) {
    const name = containerName(`canary-${mode.slice(2, 14)}`)
    const result = await runDocker(
      supervisorRoot,
      [
        ...commonContainerArgs(name),
        observerBinary,
        observerBinary,
        mode,
      ],
      { capture: true },
    )
    const evidence = `${result.stdout}\n${result.stderr}`
    if (
      result.code !== expectedExit ||
      result.signal !== null ||
      evidence.includes('AGENC_OS_NETWORK_BOUNDARY_VIOLATION')
    ) {
      throw new Error(
        [
          `Hermetic OS boundary exit-status canary failed: ${mode}`,
          `expected exit ${expectedExit} with no violation evidence`,
          `received exit ${String(result.code)} signal ${String(result.signal)}`,
          evidence.trim(),
        ].join('\n'),
      )
    }
  }
}

function containerName(label) {
  return `agenc-test-${process.pid}-${label}-${randomBytes(4).toString('hex')}`
}

async function runRequiredGates(supervisorRoot) {
  const name = containerName('suite')
  const result = await runDocker(supervisorRoot, [
    ...commonContainerArgs(name),
    observerBinary,
    'sh',
    '-c',
    'umask 077 && mkdir -p "$HOME" && chmod 700 "$HOME" && node ../node_modules/typescript/bin/tsc --noEmit && exec node scripts/run-hermetic-vitest.mjs "$@"',
    'agenc-hermetic-suite',
    ...requestedArgs,
  ])
  if (result.signal !== null) {
    process.stderr.write(`Hermetic test container exited on ${result.signal}\n`)
    return 1
  }
  if (result.code === BOUNDARY_EXIT) {
    process.stderr.write(
      'Hermetic test container rejected an OS-level network or boundary-bypass attempt\n',
    )
  }
  return result.code ?? 1
}

let activeBoundaryRoot

async function main() {
  if (
    process.platform !== 'linux' ||
    process.getuid === undefined ||
    !['x64', 'arm64'].includes(process.arch)
  ) {
    throw new Error(
      'The authoritative npm test boundary requires a Linux Docker host. Use a Linux CI/dev host for the required gate; test:host-functional is non-authoritative.',
    )
  }
  activeBoundaryRoot = createHermeticRunRoot('agc-')
  const toolInputRoot = createHermeticRunRoot('agi-')
  let uninstallSignalHandlers = () => {}
  try {
    assertSafeBindTree(repositoryRoot, 'repository')
    if (!isWithin(repositoryRoot, gitCommonDirectory)) {
      assertSafeBindTree(gitCommonDirectory, 'Git metadata')
    }
    activeDockerSeccompProfile = snapshotDockerSeccompProfile(toolInputRoot)
    activePasswdFile = snapshotBoundaryPasswd(toolInputRoot)
    activeRipgrepBinary = snapshotBundledRipgrep(toolInputRoot)
    mkdirSync(join(activeBoundaryRoot, 'docker-config'), {
      mode: 0o700,
      recursive: true,
    })
    mkdirSync(join(runtimeRoot, 'node_modules', '.vite-temp'), {
      mode: 0o700,
      recursive: true,
    })
    uninstallSignalHandlers = installSignalHandlers(activeBoundaryRoot)
    requireBoundaryPlatform(activeBoundaryRoot)
    requirePinnedImage(activeBoundaryRoot)
    await verifyDaemonResolvedBindInputs(activeBoundaryRoot)
    await verifyDaemonBindInputScannerCanaries(activeBoundaryRoot)
    await compileObserver(activeBoundaryRoot)
    await verifyObserver(activeBoundaryRoot)
    if (interruptedSignal !== undefined) return 1
    return await runRequiredGates(activeBoundaryRoot)
  } finally {
    removeContainer(activeBoundaryRoot, activeContainer)
    uninstallSignalHandlers()
    rmSync(activeBoundaryRoot, { force: true, recursive: true })
    rmSync(toolInputRoot, { force: true, recursive: true })
  }
}

function isEntrypoint() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  try {
    process.exitCode = await main()
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
