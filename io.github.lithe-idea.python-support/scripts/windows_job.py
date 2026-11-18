"""Own a test subprocess tree with a Windows job for the request's lifetime."""

import ctypes
from ctypes import wintypes
import subprocess

_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_PROCESS_TERMINATE = 0x0001
_PROCESS_SET_QUOTA = 0x0100


class _BasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("perProcessUserTimeLimit", ctypes.c_longlong),
        ("perJobUserTimeLimit", ctypes.c_longlong),
        ("limitFlags", wintypes.DWORD),
        ("minimumWorkingSetSize", ctypes.c_size_t),
        ("maximumWorkingSetSize", ctypes.c_size_t),
        ("activeProcessLimit", wintypes.DWORD),
        ("affinity", ctypes.c_size_t),
        ("priorityClass", wintypes.DWORD),
        ("schedulingClass", wintypes.DWORD),
    ]


class _ExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("basicLimitInformation", _BasicLimitInformation),
        ("ioCounters", ctypes.c_ulonglong * 6),
        ("processMemoryLimit", ctypes.c_size_t),
        ("jobMemoryLimit", ctypes.c_size_t),
        ("peakProcessMemoryUsed", ctypes.c_size_t),
        ("peakJobMemoryUsed", ctypes.c_size_t),
    ]


_kernel = ctypes.WinDLL("kernel32", use_last_error=True)
_create_job = _kernel.CreateJobObjectW
_create_job.argtypes = (wintypes.LPVOID, wintypes.LPCWSTR)
_create_job.restype = wintypes.HANDLE
_set_job = _kernel.SetInformationJobObject
_set_job.argtypes = (wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD)
_set_job.restype = wintypes.BOOL
_assign_job = _kernel.AssignProcessToJobObject
_assign_job.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
_assign_job.restype = wintypes.BOOL
_open_process = _kernel.OpenProcess
_open_process.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
_open_process.restype = wintypes.HANDLE
_close_handle = _kernel.CloseHandle
_close_handle.argtypes = (wintypes.HANDLE,)
_close_handle.restype = wintypes.BOOL

# The isolated bootstrap waits on stdin before launching the requested tool.
# Popen only exposes the process ID, so this handshake keeps its child creation
# behind job assignment without reaching into private process/thread handles.
_BOOTSTRAP = """import subprocess, sys
if sys.stdin.buffer.read(1) != b"1":
    sys.exit(1)
sys.exit(subprocess.call(sys.argv[1:], stdin=subprocess.DEVNULL))
"""


class WindowsJob:
    def __init__(self):
        self._handle = _create_job(None, None)
        if not self._handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = _ExtendedLimitInformation()
        limits.basicLimitInformation.limitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not _set_job(
            self._handle,
            _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(limits),
            ctypes.sizeof(limits),
        ):
            code = ctypes.get_last_error()
            self.close()
            raise ctypes.WinError(code)

    def start(self, bootstrap_python, argv, *, cwd, env):
        process = subprocess.Popen(
            [bootstrap_python, "-I", "-S", "-B", "-c", _BOOTSTRAP, *argv],
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        try:
            handle = _open_process(_PROCESS_TERMINATE | _PROCESS_SET_QUOTA, False, process.pid)
            if not handle:
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                if not _assign_job(self._handle, handle):
                    raise ctypes.WinError(ctypes.get_last_error())
            finally:
                _close_handle(handle)
            process.stdin.write(b"1")
            process.stdin.close()
            return process
        except (OSError, ValueError):
            process.kill()
            process.wait(timeout=2)
            process.stdin.close()
            process.stdout.close()
            raise

    def close(self):
        if self._handle:
            handle, self._handle = self._handle, None
            if not _close_handle(handle):
                raise ctypes.WinError(ctypes.get_last_error())
