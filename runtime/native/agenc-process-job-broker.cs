using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace AgenC
{
    internal static class ProcessJobBroker
    {
        private const uint CreateSuspended = 0x00000004;
        private const uint StartfUseStdHandles = 0x00000100;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private const uint Synchronize = 0x00100000;
        private const uint Infinite = 0xffffffff;
        private const uint WaitObject0 = 0x00000000;
        private const uint WaitFailed = 0xffffffff;
        private const int BrokerFailureExitCode = 125;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            internal int cb;
            internal string lpReserved;
            internal string lpDesktop;
            internal string lpTitle;
            internal int dwX;
            internal int dwY;
            internal int dwXSize;
            internal int dwYSize;
            internal int dwXCountChars;
            internal int dwYCountChars;
            internal int dwFillAttribute;
            internal uint dwFlags;
            internal short wShowWindow;
            internal short cbReserved2;
            internal IntPtr lpReserved2;
            internal IntPtr hStdInput;
            internal IntPtr hStdOutput;
            internal IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            internal IntPtr hProcess;
            internal IntPtr hThread;
            internal uint dwProcessId;
            internal uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            internal long PerProcessUserTimeLimit;
            internal long PerJobUserTimeLimit;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSetSize;
            internal UIntPtr MaximumWorkingSetSize;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass;
            internal uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            internal ulong ReadOperationCount;
            internal ulong WriteOperationCount;
            internal ulong OtherOperationCount;
            internal ulong ReadTransferCount;
            internal ulong WriteTransferCount;
            internal ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            internal JobObjectBasicLimitInformation BasicLimitInformation;
            internal IoCounters IoInfo;
            internal UIntPtr ProcessMemoryLimit;
            internal UIntPtr JobMemoryLimit;
            internal UIntPtr PeakProcessMemoryUsed;
            internal UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateJobObject(
            IntPtr attributes,
            string name
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int infoClass,
            IntPtr information,
            uint informationLength
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(
            IntPtr job,
            IntPtr process
        );

        [DllImport(
            "kernel32.dll",
            SetLastError = true,
            CharSet = CharSet.Unicode
        )]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref StartupInfo startupInfo,
            out ProcessInformation processInformation
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(
            uint desiredAccess,
            bool inheritHandle,
            uint processId
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForMultipleObjects(
            uint count,
            IntPtr[] handles,
            bool waitAll,
            uint milliseconds
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(
            IntPtr process,
            out uint exitCode
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(
            IntPtr process,
            uint exitCode
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetStdHandle(int standardHandle);

        internal static int Main()
        {
            try
            {
                string program = ReadBase64Environment(
                    "AGENC_PROCESS_JOB_PROGRAM"
                );
                string commandLine = ReadBase64Environment(
                    "AGENC_PROCESS_JOB_COMMAND_LINE"
                );
                string ownerValue = Environment.GetEnvironmentVariable(
                    "AGENC_PROCESS_JOB_OWNER_PID"
                );

                Environment.SetEnvironmentVariable(
                    "AGENC_PROCESS_JOB_PROGRAM",
                    null
                );
                Environment.SetEnvironmentVariable(
                    "AGENC_PROCESS_JOB_COMMAND_LINE",
                    null
                );
                Environment.SetEnvironmentVariable(
                    "AGENC_PROCESS_JOB_OWNER_PID",
                    null
                );

                int ownerProcessId;
                if (
                    !int.TryParse(ownerValue, out ownerProcessId) ||
                    ownerProcessId <= 1
                )
                {
                    throw new InvalidOperationException(
                        "invalid owner process id"
                    );
                }
                if (program.Length == 0 || commandLine.Length == 0)
                {
                    throw new InvalidOperationException(
                        "missing contained-process command"
                    );
                }

                return Run(
                    program,
                    commandLine,
                    Environment.CurrentDirectory,
                    ownerProcessId
                );
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(
                    "AgenC Windows process containment broker failed: " +
                    error.Message
                );
                return BrokerFailureExitCode;
            }
        }

        private static string ReadBase64Environment(string name)
        {
            string value = Environment.GetEnvironmentVariable(name);
            if (String.IsNullOrEmpty(value))
            {
                throw new InvalidOperationException(
                    "missing process containment input"
                );
            }
            return Encoding.UTF8.GetString(
                Convert.FromBase64String(value)
            );
        }

        private static void Check(bool result, string operation)
        {
            if (!result)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    operation
                );
            }
        }

        private static int Run(
            string applicationName,
            string commandLine,
            string currentDirectory,
            int ownerProcessId
        )
        {
            IntPtr job = IntPtr.Zero;
            IntPtr owner = IntPtr.Zero;
            ProcessInformation process = new ProcessInformation();
            bool processCreated = false;
            bool resumed = false;
            try
            {
                owner = OpenProcess(
                    Synchronize,
                    false,
                    (uint)ownerProcessId
                );
                if (owner == IntPtr.Zero)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "OpenProcess(owner)"
                    );
                }

                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "CreateJobObject"
                    );
                }

                JobObjectExtendedLimitInformation limits =
                    new JobObjectExtendedLimitInformation();
                limits.BasicLimitInformation.LimitFlags =
                    JobObjectLimitKillOnJobClose;
                int limitSize = Marshal.SizeOf(limits);
                IntPtr limitBuffer = Marshal.AllocHGlobal(limitSize);
                try
                {
                    Marshal.StructureToPtr(limits, limitBuffer, false);
                    Check(
                        SetInformationJobObject(
                            job,
                            9,
                            limitBuffer,
                            (uint)limitSize
                        ),
                        "SetInformationJobObject"
                    );
                }
                finally
                {
                    Marshal.FreeHGlobal(limitBuffer);
                }

                StartupInfo startup = new StartupInfo();
                startup.cb = Marshal.SizeOf(startup);
                startup.dwFlags = StartfUseStdHandles;
                startup.hStdInput = GetStdHandle(-10);
                startup.hStdOutput = GetStdHandle(-11);
                startup.hStdError = GetStdHandle(-12);

                Check(
                    CreateProcess(
                        applicationName,
                        new StringBuilder(commandLine),
                        IntPtr.Zero,
                        IntPtr.Zero,
                        true,
                        CreateSuspended,
                        IntPtr.Zero,
                        currentDirectory,
                        ref startup,
                        out process
                    ),
                    "CreateProcess"
                );
                processCreated = true;

                Check(
                    AssignProcessToJobObject(job, process.hProcess),
                    "AssignProcessToJobObject"
                );
                if (ResumeThread(process.hThread) == 0xffffffff)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "ResumeThread"
                    );
                }
                resumed = true;

                IntPtr[] waitHandles = new IntPtr[]
                {
                    process.hProcess,
                    owner
                };
                uint waitResult = WaitForMultipleObjects(
                    (uint)waitHandles.Length,
                    waitHandles,
                    false,
                    Infinite
                );
                if (waitResult == WaitFailed)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "WaitForMultipleObjects"
                    );
                }
                if (waitResult == WaitObject0 + 1)
                {
                    // Closing the KILL_ON_JOB_CLOSE handle in finally is the
                    // recursive ownership backstop. Stop the leader first so
                    // owner-death shutdown is immediate.
                    TerminateProcess(process.hProcess, 1);
                    return 1;
                }
                if (waitResult != WaitObject0)
                {
                    throw new InvalidOperationException(
                        "unexpected process ownership wait result"
                    );
                }

                uint exitCode;
                Check(
                    GetExitCodeProcess(process.hProcess, out exitCode),
                    "GetExitCodeProcess"
                );
                return unchecked((int)exitCode);
            }
            finally
            {
                if (processCreated && !resumed)
                {
                    TerminateProcess(process.hProcess, 1);
                }
                if (process.hThread != IntPtr.Zero)
                {
                    CloseHandle(process.hThread);
                }
                if (process.hProcess != IntPtr.Zero)
                {
                    CloseHandle(process.hProcess);
                }
                if (job != IntPtr.Zero)
                {
                    CloseHandle(job);
                }
                if (owner != IntPtr.Zero)
                {
                    CloseHandle(owner);
                }
            }
        }
    }
}
