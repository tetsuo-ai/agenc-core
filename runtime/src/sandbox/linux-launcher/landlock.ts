import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SECCOMP_STDIN_FD } from "./config.js";
import {
  networkPolicyEnabled,
  type NetworkSandboxPolicy,
} from "../engine/index.js";

const BPF_LD = 0x00;
const BPF_W = 0x00;
const BPF_ABS = 0x20;
const BPF_JMP = 0x05;
const BPF_JEQ = 0x10;
const BPF_K = 0x00;
const BPF_RET = 0x06;

const SECCOMP_DATA_NR_OFFSET = 0;
const SECCOMP_DATA_ARCH_OFFSET = 4;
const SECCOMP_DATA_ARGS_OFFSET = 16;
const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 10;
const EPERM = 1;

const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;

export type NetworkSeccompMode = "restricted" | "proxy-routed";

export interface SeccompProgramFile {
  readonly fd: number;
  readonly path: string;
  readonly stdioFd: number;
  cleanup(): void;
}

interface SyscallTable {
  readonly auditArch: number;
  readonly ptrace: number;
  readonly processVmReadv: number;
  readonly processVmWritev: number;
  readonly ioUringSetup: number;
  readonly ioUringEnter: number;
  readonly ioUringRegister: number;
  readonly socket: number;
  readonly socketpair: number;
  readonly connect: number;
  readonly accept: number;
  readonly accept4: number;
  readonly bind: number;
  readonly listen: number;
  readonly getpeername: number;
  readonly getsockname: number;
  readonly shutdown: number;
  readonly sendto: number;
  readonly sendmmsg: number;
  readonly recvmmsg: number;
  readonly getsockopt: number;
  readonly setsockopt: number;
}

export function shouldInstallNetworkSeccomp(
  networkSandboxPolicy: NetworkSandboxPolicy,
  allowNetworkForProxy: boolean,
): boolean {
  return !networkPolicyEnabled(networkSandboxPolicy) || allowNetworkForProxy;
}

export function networkSeccompMode(
  networkSandboxPolicy: NetworkSandboxPolicy,
  allowNetworkForProxy: boolean,
  proxyRoutedNetwork: boolean,
): NetworkSeccompMode | null {
  if (!shouldInstallNetworkSeccomp(networkSandboxPolicy, allowNetworkForProxy)) {
    return null;
  }
  return proxyRoutedNetwork ? "proxy-routed" : "restricted";
}

export function openNetworkSeccompProgramFile(
  mode: NetworkSeccompMode,
  arch: NodeJS.Architecture = process.arch,
): SeccompProgramFile {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-seccomp-"));
  const filePath = path.join(dir, "network.bpf");
  const fd = fs.openSync(filePath, "w+");
  const program = createNetworkSeccompProgram(mode, arch);
  fs.writeSync(fd, program, 0, program.length, 0);
  return {
    fd,
    path: filePath,
    stdioFd: SECCOMP_STDIN_FD,
    cleanup() {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed by the caller.
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup after the sandboxed process exits.
      }
    },
  };
}

export function createNetworkSeccompProgram(
  mode: NetworkSeccompMode,
  arch: NodeJS.Architecture = process.arch,
): Buffer {
  const table = syscallTableForArchitecture(arch);
  const program = new BpfProgram();
  program.loadWord(SECCOMP_DATA_ARCH_OFFSET);
  program.jumpEqual(table.auditArch, 1, 0);
  program.ret(SECCOMP_RET_KILL_PROCESS);
  program.loadWord(SECCOMP_DATA_NR_OFFSET);

  const alwaysDenied = [
    table.ptrace,
    table.processVmReadv,
    table.processVmWritev,
    table.ioUringSetup,
    table.ioUringEnter,
    table.ioUringRegister,
  ];
  for (const syscall of alwaysDenied) {
    program.denySyscall(syscall);
  }

  if (mode === "restricted") {
    program.allowUnixSocketOnly(table.socket);
    program.allowUnixSocketOnly(table.socketpair);
    for (const syscall of restrictedNetworkDeniedSyscalls(table)) {
      program.denySyscall(syscall);
    }
  } else {
    program.allowIpSocketOnly(table.socket);
    program.denySyscall(table.socketpair);
    for (const syscall of restrictedNetworkDeniedSyscalls(table)) {
      program.denySyscall(syscall);
    }
  }

  program.ret(SECCOMP_RET_ALLOW);
  return program.toBuffer();
}

function restrictedNetworkDeniedSyscalls(table: SyscallTable): number[] {
  return [
    table.connect,
    table.accept,
    table.accept4,
    table.bind,
    table.listen,
    table.getpeername,
    table.getsockname,
    table.shutdown,
    table.sendto,
    table.sendmmsg,
    table.recvmmsg,
    table.getsockopt,
    table.setsockopt,
  ];
}

function syscallTableForArchitecture(arch: NodeJS.Architecture): SyscallTable {
  switch (arch) {
    case "x64":
      return {
        auditArch: 0xc000003e,
        ptrace: 101,
        processVmReadv: 310,
        processVmWritev: 311,
        ioUringSetup: 425,
        ioUringEnter: 426,
        ioUringRegister: 427,
        socket: 41,
        socketpair: 53,
        connect: 42,
        accept: 43,
        accept4: 288,
        bind: 49,
        listen: 50,
        getpeername: 52,
        getsockname: 51,
        shutdown: 48,
        sendto: 44,
        sendmmsg: 307,
        recvmmsg: 299,
        getsockopt: 55,
        setsockopt: 54,
      };
    case "arm64":
      return {
        auditArch: 0xc00000b7,
        ptrace: 117,
        processVmReadv: 270,
        processVmWritev: 271,
        ioUringSetup: 425,
        ioUringEnter: 426,
        ioUringRegister: 427,
        socket: 198,
        socketpair: 199,
        bind: 200,
        listen: 201,
        accept: 202,
        connect: 203,
        getsockname: 204,
        getpeername: 205,
        sendto: 206,
        getsockopt: 209,
        setsockopt: 208,
        shutdown: 210,
        accept4: 242,
        recvmmsg: 243,
        sendmmsg: 269,
      };
    default:
      throw new Error(`Linux seccomp program generation does not support ${arch}`);
  }
}

interface BpfInstruction {
  readonly code: number;
  readonly jt: number;
  readonly jf: number;
  readonly k: number;
}

class BpfProgram {
  readonly #instructions: BpfInstruction[] = [];

  loadWord(offset: number): void {
    this.#instructions.push({
      code: BPF_LD | BPF_W | BPF_ABS,
      jt: 0,
      jf: 0,
      k: offset,
    });
  }

  jumpEqual(value: number, jt: number, jf: number): void {
    this.#instructions.push({
      code: BPF_JMP | BPF_JEQ | BPF_K,
      jt,
      jf,
      k: value >>> 0,
    });
  }

  ret(value: number): void {
    this.#instructions.push({
      code: BPF_RET | BPF_K,
      jt: 0,
      jf: 0,
      k: value >>> 0,
    });
  }

  denySyscall(syscall: number): void {
    this.jumpEqual(syscall, 0, 1);
    this.ret(SECCOMP_RET_ERRNO | EPERM);
  }

  allowUnixSocketOnly(syscall: number): void {
    this.jumpEqual(syscall, 0, 4);
    this.loadWord(SECCOMP_DATA_ARGS_OFFSET);
    this.jumpEqual(AF_UNIX, 0, 1);
    this.ret(SECCOMP_RET_ALLOW);
    this.ret(SECCOMP_RET_ERRNO | EPERM);
  }

  allowIpSocketOnly(syscall: number): void {
    this.jumpEqual(syscall, 0, 5);
    this.loadWord(SECCOMP_DATA_ARGS_OFFSET);
    this.jumpEqual(AF_INET, 2, 0);
    this.jumpEqual(AF_INET6, 1, 0);
    this.ret(SECCOMP_RET_ERRNO | EPERM);
    this.ret(SECCOMP_RET_ALLOW);
  }

  toBuffer(): Buffer {
    const buffer = Buffer.alloc(this.#instructions.length * 8);
    for (const [index, instruction] of this.#instructions.entries()) {
      const offset = index * 8;
      buffer.writeUInt16LE(instruction.code, offset);
      buffer.writeUInt8(instruction.jt, offset + 2);
      buffer.writeUInt8(instruction.jf, offset + 3);
      buffer.writeUInt32LE(instruction.k >>> 0, offset + 4);
    }
    return buffer;
  }
}
