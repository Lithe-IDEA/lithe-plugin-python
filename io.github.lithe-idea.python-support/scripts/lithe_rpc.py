import os
import sys

# Never write bytecode into the installed read-only plugin package or user workspace.
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

from concurrent.futures import ThreadPoolExecutor
import json
import re
import signal
import subprocess
import threading
import time
from typing import Any, Callable, Optional

FUNCTIONS_VERSION = 0
BUILD_VERSIONS = (1, 0)
LOGGING_VERSION = 0

MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_INCOMING_FRAME_BYTES = 16 * 1024 * 1024
MAX_IN_FLIGHT_REQUESTS = 32
MAX_FUNCTION_RESULT_BYTES = 1024 * 1024
MAX_BUILD_RESULT_BYTES = 32 * 1024 * 1024
MAX_BUILD_MESSAGE_BYTES = 4096
MAX_BUILD_OUTPUT_BYTES = 65536
MAX_ERROR_MESSAGE_BYTES = 1024

ERROR_PARSE = -32700
ERROR_INVALID_REQUEST = -32600
ERROR_METHOD_NOT_FOUND = -32601
ERROR_INVALID_PARAMS = -32602
ERROR_INTERNAL = -32603
ERROR_SERVER_NOT_INITIALIZED = -32002
ERROR_REQUEST_FAILED = -32000
ERROR_REQUEST_CANCELLED = -32800


KNOWN_LOGGING_OPERATIONS = frozenset({
    "initialize",
    "shutdown",
    "notification",
    "function-call",
    "result-encoding",
    "lithe/keymap/import",
    "lithe/build/model",
    "lithe/build/dependencies",
    "lithe/build/execute",
    "lithe/build/test",
    "lithe/build/discoverTests",
    "lithe/build/prepareRun",
    "lithe/build/prepareDebug",
    "lithe/build/runEntrypoints",
    "lithe/vcs/status",
    "lithe/vcs/baseContent",
    "lithe/vcs/history",
    "lithe/vcs/fileHistory",
    "lithe/vcs/annotate",
    "lithe/vcs/checkin",
    "lithe/vcs/rollback",
    "lithe/vcs/update",
    "lithe/vcs/fileOperation",
    "lithe/vcs/resolve",
    "lithe/vcs/cleanup",
})

BUILD_FORMATS = {
    "lithe/build/model": "litheBuildModel",
    "lithe/build/dependencies": "litheDependencies",
    "lithe/build/discoverTests": "litheTestDiscovery",
    "lithe/build/runEntrypoints": "litheRunEntrypoints",
}

_LOG_TOKEN_RE = re.compile(r"^[A-Za-z0-9._:/\-$]+$")
_PLUGIN_ERROR_CODE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9._-]*$")
_FUNCTION_SEGMENT_RE = re.compile(r"^[a-z][A-Za-z0-9]*$")
_PROVIDER_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


def is_log_token(value: Any, limit: int) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value.encode("utf-8")) <= limit
        and _LOG_TOKEN_RE.match(value) is not None
    )


def is_plugin_error_code(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value.encode("utf-8")) <= 64
        and _PLUGIN_ERROR_CODE_RE.match(value) is not None
    )


def is_function_id(value: Any) -> bool:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 128:
        return False
    return all(_FUNCTION_SEGMENT_RE.match(part) is not None for part in value.split("."))


def bounded_utf8(text: Any, limit: int = MAX_ERROR_MESSAGE_BYTES) -> str:
    value = str(text or "")
    encoded = value.encode("utf-8")
    if len(encoded) <= limit:
        return value
    return encoded[:limit].decode("utf-8", errors="ignore")


def request_key(req_id: Any) -> str:
    if isinstance(req_id, bool):
        return f"bool:{req_id}"
    if isinstance(req_id, int):
        return f"int:{req_id}"
    return f"{type(req_id).__name__}:{req_id}"


def request_operation_id(operation_id: Any, req_id: Any) -> Optional[str]:
    if is_log_token(operation_id, 128):
        return operation_id
    fallback: Optional[str] = None
    if isinstance(req_id, str):
        fallback = req_id
    elif isinstance(req_id, int) and not isinstance(req_id, bool):
        fallback = str(req_id)
    return fallback if is_log_token(fallback, 128) else None


class CancelledError(Exception):
    """Raised when the host cancels an active request or shuts down the session."""


class PluginError(Exception):
    """Controlled user-facing error with a stable pluginErrorCode and zero private paths."""

    def __init__(self, code: str, message: str) -> None:
        if not is_plugin_error_code(code):
            raise ValueError(f"Invalid plugin error code: {code!r}")
        super().__init__(message)
        self.code = code
        self.user_message = bounded_utf8(message, MAX_ERROR_MESSAGE_BYTES)


class FramingError(Exception):
    """Raised when the incoming stdio stream violates Content-Length framing."""


class CancelToken:
    """Shares cancellation with a queued or running request."""

    def __init__(self) -> None:
        self._event = threading.Event()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def raise_if_cancelled(self) -> None:
        if self._event.is_set():
            raise CancelledError("Request cancelled")

    def wait(self, timeout: float) -> bool:
        return self._event.wait(timeout)

    def cancel(self) -> None:
        self._event.set()


def run_bounded_process(
    argv: list[str],
    *,
    cwd: str,
    env: dict[str, str],
    cancel_token: CancelToken,
    timeout_seconds: float,
    max_output_bytes: int = 8 * 1024 * 1024,
    on_output: Optional[Callable[[str], None]] = None,
) -> tuple[int, str, bool]:
    """
    Runs a child process in its own process group with bounded timeout, bounded output,
    and immediate termination on request cancellation.
    Returns (exit_code, combined_output, timed_out).
    """
    cancel_token.raise_if_cancelled()
    job = None
    if os.name == "nt":
        from windows_job import WindowsJob

        job = WindowsJob()
        try:
            # A Windows virtualenv redirector can create a child before its
            # interpreter starts. The base executable keeps bootstrap atomic.
            proc = job.start(sys._base_executable, argv, cwd=cwd, env=env)
        except Exception:
            job.close()
            raise
    else:
        proc = subprocess.Popen(
            argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    chunks: list[bytes] = []
    captured_bytes = 0
    lock = threading.Lock()

    def _reader() -> None:
        nonlocal captured_bytes
        stream = proc.stdout
        if stream is None:
            return
        try:
            while True:
                data = stream.read1(4096)
                if not data:
                    break
                text_chunk: Optional[str] = None
                with lock:
                    if captured_bytes < max_output_bytes:
                        remaining = max_output_bytes - captured_bytes
                        kept = data[:remaining]
                        chunks.append(kept)
                        captured_bytes += len(kept)
                        text_chunk = kept.decode("utf-8", errors="replace")
                if text_chunk and on_output is not None:
                    on_output(text_chunk)
        except Exception:
            pass
        finally:
            try:
                stream.close()
            except Exception:
                pass

    reader_thread = threading.Thread(target=_reader, daemon=True)
    deadline = time.monotonic() + max(0.1, timeout_seconds)
    timed_out = False
    try:
        reader_thread.start()
        while proc.poll() is None:
            cancel_token.raise_if_cancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            try:
                proc.wait(timeout=min(0.05, remaining))
            except subprocess.TimeoutExpired:
                continue
    finally:
        # The request owns the whole group, even after its direct child exits.
        # Closing the Windows job or killing the POSIX group releases inherited
        # output handles left open by surviving descendants before draining.
        if job is not None:
            job.close()
        else:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        proc.wait(timeout=2.0)
        if reader_thread.ident is None:
            proc.stdout.close()
        else:
            reader_thread.join(timeout=2.0)

    cancel_token.raise_if_cancelled()
    exit_code = proc.returncode
    with lock:
        output = b"".join(chunks).decode("utf-8", errors="replace")
    return exit_code, output, timed_out


class DiagnosticsReporter:
    """Emits validated lithe/log notifications with controlled category codes only."""

    def __init__(
        self,
        send_fn: Callable[[dict[str, Any]], None],
        is_registered_fn: Callable[[str], bool],
        operation_id: Optional[str] = None,
    ) -> None:
        self._send = send_fn
        self._is_registered = is_registered_fn
        self._operation_id = operation_id

    def _record(
        self,
        kind: str,
        operation: str,
        code: Optional[str] = None,
        count: Optional[int] = None,
        duration_ms: Optional[int] = None,
    ) -> None:
        if operation not in KNOWN_LOGGING_OPERATIONS and not self._is_registered(operation):
            raise ValueError(f"Unregistered diagnostic operation: {operation!r}")
        if code is not None and not is_log_token(code, 64):
            raise ValueError(f"Invalid controlled diagnostic code: {code!r}")
        if count is not None and (isinstance(count, bool) or not isinstance(count, int) or count < 0 or count > MAX_SAFE_INTEGER):
            raise ValueError(f"Invalid diagnostic count: {count!r}")
        wire_op = operation if len(operation.encode("utf-8")) <= 64 else "function-call"
        params: dict[str, Any] = {
            "kind": kind,
            "operation": wire_op,
        }
        if code is not None:
            params["code"] = code
        if count is not None:
            params["count"] = count
        if duration_ms is not None:
            clamped = min(MAX_SAFE_INTEGER, max(0, int(duration_ms)))
            params["durationMs"] = clamped
        if self._operation_id is not None and is_log_token(self._operation_id, 128):
            params["operationId"] = self._operation_id
        self._send(params)

    def degraded(self, operation: str, code: str, count: Optional[int] = None) -> None:
        self._record("degraded", operation, code=code, count=count)

    def recovered(self, operation: str, code: str, count: Optional[int] = None) -> None:
        self._record("recovered", operation, code=code, count=count)

    def terminal(self, operation: str, error_code: Optional[str], duration_ms: float) -> None:
        if error_code is not None:
            safe_code = error_code if is_log_token(error_code, 64) else "internal_error"
            self._record("operationFailed", operation, code=safe_code, duration_ms=int(duration_ms))
        else:
            self._record("operationFinished", operation, duration_ms=int(duration_ms))


class CallContext:
    """Per-request execution context passed to function and build handlers."""

    def __init__(
        self,
        *,
        cancel_token: CancelToken,
        diagnostics: DiagnosticsReporter,
        suppress_cb: Callable[[], None],
        operation_id: Optional[str] = None,
        progress_cb: Optional[Callable[[dict[str, Any]], None]] = None,
        workspace_context: Optional[dict[str, Any]] = None,
    ) -> None:
        self.cancel_token = cancel_token
        self.diagnostics = diagnostics
        self._suppress_cb = suppress_cb
        self.operation_id = operation_id
        self._progress_cb = progress_cb
        self.workspace_context = workspace_context

    def suppress_success_diagnostics(self) -> None:
        self._suppress_cb()

    def raise_if_cancelled(self) -> None:
        self.cancel_token.raise_if_cancelled()

    def progress(
        self,
        *,
        message: Optional[str] = None,
        percentage: Optional[int] = None,
        output: Optional[str] = None,
    ) -> None:
        if self._progress_cb is not None and not self.cancel_token.cancelled:
            payload: dict[str, Any] = {}
            if message is not None:
                payload["message"] = message
            if percentage is not None:
                payload["percentage"] = percentage
            if output is not None:
                payload["output"] = output
            self._progress_cb(payload)


class _MalformedJsonSentinel:
    pass


_MALFORMED_JSON = _MalformedJsonSentinel()


class FrameDecoder:
    """Incremental Content-Length JSON-RPC frame parser."""

    def __init__(self) -> None:
        self._buf = bytearray()

    def push(self, chunk: bytes) -> list[Any]:
        self._buf.extend(chunk)
        messages: list[Any] = []
        while True:
            sep = self._buf.find(b"\r\n\r\n")
            if sep < 0:
                if len(self._buf) > 65536:
                    raise FramingError("Header exceeds 64 KiB without CRLFCRLF terminator")
                break
            header_bytes = bytes(self._buf[:sep])
            content_length: Optional[int] = None
            for raw_line in header_bytes.split(b"\r\n"):
                if not raw_line:
                    continue
                colon = raw_line.find(b":")
                if colon <= 0:
                    raise FramingError("Malformed header line")
                name = raw_line[:colon].strip().lower()
                val = raw_line[colon + 1 :].strip()
                if name == b"content-length":
                    if not val.isdigit():
                        raise FramingError("Invalid Content-Length")
                    content_length = int(val)
            if content_length is None or content_length > MAX_INCOMING_FRAME_BYTES:
                raise FramingError("Missing or oversized Content-Length")
            total = sep + 4 + content_length
            if len(self._buf) < total:
                break
            body = bytes(self._buf[sep + 4 : total])
            del self._buf[:total]
            try:
                messages.append(json.loads(body.decode("utf-8")))
            except Exception:
                messages.append(_MALFORMED_JSON)
        return messages


def encode_frame(payload: dict[str, Any]) -> bytes:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    header = f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii")
    return header + raw


class JsonRpcServer:
    """
    Pure-Python Lithe plugin backend / build provider stdio JSON-RPC server.
    Implements litheLogging 0, litheFunctions 0, and litheBuild 0/1.
    """

    def __init__(self, *, name: str, version: str = "0.2.0") -> None:
        self.name = name
        self.version = version
        self._functions: dict[str, Callable[[dict[str, Any], CallContext], Any]] = {}
        self._build_handlers: dict[str, Callable[[dict[str, Any], CallContext], Any]] = {}
        self._quiet_success: set[str] = set()
        self._initialize_hooks: list[Callable[[dict[str, Any]], None]] = []
        self._shutdown_hooks: list[Callable[[], None]] = []

        self._phase = "idle"
        self._logging_negotiated = False
        self._logging_ready = False
        self._early_diagnostics: list[dict[str, Any]] = []
        self._functions_version: Optional[int] = None
        self._build_version: Optional[int] = None
        self.initialize_params: Optional[dict[str, Any]] = None

        self._write_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._incoming: dict[str, CancelToken] = {}
        self._output_stream: Any = None
        self._error_stream: Any = sys.stderr
        self._exit_code: Optional[int] = None
        self._done_event = threading.Event()
        self._executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix=f"{name}-worker")

    def function(self, fn_id: str, handler: Callable[[dict[str, Any], CallContext], Any]) -> "JsonRpcServer":
        if not is_function_id(fn_id):
            raise ValueError(f"Invalid function ID: {fn_id!r}")
        if fn_id in self._functions:
            raise ValueError(f"Duplicate function ID: {fn_id!r}")
        self._functions[fn_id] = handler
        return self

    def build_handler(self, method: str, handler: Callable[[dict[str, Any], CallContext], Any]) -> "JsonRpcServer":
        if not method.startswith("lithe/build/"):
            raise ValueError(f"Invalid build method: {method!r}")
        self._build_handlers[method] = handler
        return self


    def suppress_success_diagnostics(self, operation: str) -> "JsonRpcServer":
        if operation not in KNOWN_LOGGING_OPERATIONS and operation not in self._functions:
            raise ValueError(f"Cannot suppress unknown operation: {operation!r}")
        self._quiet_success.add(operation)
        return self

    def on_initialize(self, hook: Callable[[dict[str, Any]], None]) -> "JsonRpcServer":
        self._initialize_hooks.append(hook)
        return self

    def on_shutdown(self, hook: Callable[[], None]) -> "JsonRpcServer":
        self._shutdown_hooks.append(hook)
        return self

    @property
    def diagnostics(self) -> DiagnosticsReporter:
        return self._make_diagnostics(None)

    def _make_diagnostics(self, operation_id: Optional[str]) -> DiagnosticsReporter:
        def _send(params: dict[str, Any]) -> None:
            with self._state_lock:
                if not self._logging_negotiated or self._phase == "exited":
                    return
                if not self._logging_ready:
                    if len(self._early_diagnostics) < 8:
                        self._early_diagnostics.append(params)
                    return
            self._write_frame({"jsonrpc": "2.0", "method": "lithe/log", "params": params})

        return DiagnosticsReporter(_send, lambda op: op in self._functions, operation_id)

    def _write_frame(self, message: dict[str, Any]) -> None:
        with self._write_lock:
            if self._output_stream is None or self._phase == "exited":
                return
            data = encode_frame(message)
            self._output_stream.write(data)
            self._output_stream.flush()

    def _write_stderr_category(self, category: str, detail: Optional[str] = None) -> None:
        try:
            suffix = f" ({detail})" if detail else ""
            self._error_stream.write(f"{self.name}: {category}{suffix}\n")
            self._error_stream.flush()
        except Exception:
            pass

    def _respond(self, req_id: Any, result: Any = None, error: Optional[dict[str, Any]] = None) -> None:
        if self._phase == "exited":
            return
        try:
            if error is not None:
                self._write_frame({"jsonrpc": "2.0", "id": req_id, "error": error})
            else:
                self._write_frame({"jsonrpc": "2.0", "id": req_id, "result": result})
        except Exception:
            self.diagnostics.terminal("result-encoding", "result_encoding_failed", 0)
            self._write_frame({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": ERROR_INTERNAL,
                    "message": "The plugin backend failed unexpectedly.",
                },
            })

    def _abort_all(self) -> None:
        with self._state_lock:
            tokens = list(self._incoming.values())
            self._incoming.clear()
        for token in tokens:
            token.cancel()

    def _finish(self, code: int) -> None:
        with self._state_lock:
            if self._phase == "exited":
                return
            self._phase = "exited"
            self._exit_code = code
        self._abort_all()
        self._done_event.set()

    def listen(
        self,
        *,
        input_stream: Any = None,
        output_stream: Any = None,
        error_stream: Any = None,
    ) -> int:
        if self._phase != "idle":
            raise RuntimeError("Server can listen only once")
        in_raw = input_stream if input_stream is not None else sys.stdin.buffer
        out_raw = output_stream if output_stream is not None else sys.stdout.buffer
        err_out = error_stream if error_stream is not None else sys.stderr

        # Redirect Python-level sys.stdout to stderr so accidental print() calls never corrupt frames.
        if output_stream is None:
            sys.stdout = err_out  # type: ignore[assignment]

        self._output_stream = out_raw
        self._error_stream = err_out
        self._phase = "listening"

        decoder = FrameDecoder()
        try:
            while not self._done_event.is_set():
                chunk = in_raw.read1(8192) if hasattr(in_raw, "read1") else in_raw.read(8192)
                if not chunk:
                    self._finish(0 if self._phase == "shuttingDown" else 1)
                    break
                try:
                    messages = decoder.push(chunk)
                except FramingError:
                    self.diagnostics.terminal("notification", "framing_error", 0)
                    self._finish(1)
                    break
                for msg in messages:
                    if self._done_event.is_set():
                        break
                    self._dispatch(msg)
        finally:
            if self._phase != "exited":
                self._finish(1)
            self._executor.shutdown(wait=False, cancel_futures=True)
        return self._exit_code if self._exit_code is not None else 0

    def _dispatch(self, message: Any) -> None:
        if message is _MALFORMED_JSON:
            self._respond(None, error={"code": ERROR_PARSE, "message": "The message is not valid JSON."})
            return
        if not isinstance(message, dict):
            self._respond(None, error={"code": ERROR_INVALID_REQUEST, "message": "The message is not a JSON-RPC object."})
            return

        has_id = "id" in message and message["id"] is not None
        method = message.get("method")
        if not isinstance(method, str):
            return
        if has_id:
            self._handle_request(message["id"], method, message.get("params"))
        else:
            self._handle_notification(method, message.get("params"))

    def _handle_notification(self, method: str, params: Any) -> None:
        if method == "exit":
            self._finish(0 if self._phase == "shuttingDown" else 1)
            return
        if method == "$/cancelRequest":
            if isinstance(params, dict) and "id" in params:
                key = request_key(params["id"])
                with self._state_lock:
                    token = self._incoming.get(key)
                if token is not None:
                    token.cancel()
            return

    def _handle_request(self, req_id: Any, method: str, params: Any) -> None:
        if method == "initialize":
            self._handle_initialize(req_id, params if isinstance(params, dict) else {})
            return
        if method == "shutdown":
            self._handle_shutdown(req_id)
            return
        if self._phase in ("listening", "initializing"):
            self._respond(
                req_id,
                error={"code": ERROR_SERVER_NOT_INITIALIZED, "message": "The backend is not initialized."},
            )
            return
        if self._phase != "ready":
            self._respond(
                req_id,
                error={"code": ERROR_INVALID_REQUEST, "message": "The backend is shutting down."},
            )
            return

        if method == "lithe/function/invoke":
            self._submit(req_id, self._invoke_function, params)
            return
        if method in self._build_handlers and self._build_version is not None:
            if method == "lithe/build/runEntrypoints" and self._build_version < 1:
                self._respond(
                    req_id,
                    error={"code": ERROR_METHOD_NOT_FOUND, "message": "The requested method is not supported."},
                )
                return
            self._submit(req_id, self._invoke_build, method, params)
            return


        self._respond(
            req_id,
            error={"code": ERROR_METHOD_NOT_FOUND, "message": "The requested method is not supported."},
        )

    def _submit(self, req_id: Any, invoke: Callable[..., None], *args: Any) -> None:
        key = request_key(req_id)
        token = CancelToken()
        with self._state_lock:
            admitted = key not in self._incoming and len(self._incoming) < MAX_IN_FLIGHT_REQUESTS
            if admitted:
                self._incoming[key] = token
        if not admitted:
            self._respond(
                req_id,
                error={"code": ERROR_INVALID_REQUEST, "message": "The backend cannot accept this request."},
            )
            return

        def run() -> None:
            try:
                invoke(req_id, token, *args)
            finally:
                with self._state_lock:
                    self._incoming.pop(key, None)

        self._executor.submit(run)

    def _handle_initialize(self, req_id: Any, params: dict[str, Any]) -> None:
        if self._phase != "listening":
            self._respond(
                req_id,
                error={"code": ERROR_INVALID_REQUEST, "message": "initialize was already received."},
            )
            return
        self._phase = "initializing"
        self.initialize_params = params
        capabilities = params.get("capabilities")
        offered = capabilities.get("experimental") if isinstance(capabilities, dict) else None
        if not isinstance(offered, dict):
            offered = {}

        def _offers(entry: Any, version: int) -> bool:
            return (
                isinstance(entry, dict)
                and isinstance(entry.get("versions"), list)
                and any(not isinstance(v, bool) and v == version for v in entry["versions"])
            )

        if not _offers(offered.get("litheLogging"), LOGGING_VERSION):
            self._phase = "listening"
            self._respond(
                req_id,
                error={
                    "code": ERROR_INVALID_REQUEST,
                    "message": f"The backend requires litheLogging version {LOGGING_VERSION}.",
                },
            )
            return

        self._logging_negotiated = True
        self._logging_ready = False
        self._early_diagnostics = []

        build_ver: Optional[int] = None
        if self._build_handlers:
            for candidate_ver in BUILD_VERSIONS:
                if _offers(offered.get("litheBuild"), candidate_ver):
                    build_ver = candidate_ver
                    break
        self._build_version = build_ver

        self._functions_version = FUNCTIONS_VERSION if _offers(offered.get("litheFunctions"), FUNCTIONS_VERSION) else None


        try:
            for hook in self._initialize_hooks:
                hook(params)
        except PluginError as err:
            self._phase = "listening"
            self._respond(
                req_id,
                error={"code": ERROR_REQUEST_FAILED, "message": err.user_message, "data": {"code": err.code}},
            )
            return
        except Exception as exc:
            self._phase = "listening"
            self._write_stderr_category("initialize_failed", type(exc).__name__)
            self._respond(
                req_id,
                error={"code": ERROR_INTERNAL, "message": "The plugin backend failed unexpectedly."},
            )
            return

        if self._functions and self._functions_version is None:
            self.diagnostics.degraded("initialize", "functions_unavailable")

        experimental: dict[str, Any] = {
            "litheLogging": {"version": LOGGING_VERSION},
        }
        if self._build_version is not None:
            experimental["litheBuild"] = {"version": self._build_version}
        if self._functions_version is not None:
            experimental["litheFunctions"] = {
                "version": self._functions_version,
                "functions": [{"id": fn_id} for fn_id in sorted(self._functions)],
            }


        with self._state_lock:
            self._phase = "ready"
        self._respond(
            req_id,
            result={
                "capabilities": {"experimental": experimental},
                "serverInfo": {"name": self.name, "version": self.version},
            },
        )
        with self._state_lock:
            self._logging_ready = True
            early = list(self._early_diagnostics)
            self._early_diagnostics.clear()
        for diag_params in early:
            self._write_frame({"jsonrpc": "2.0", "method": "lithe/log", "params": diag_params})

    def _handle_shutdown(self, req_id: Any) -> None:
        if self._phase not in ("ready", "listening", "initializing"):
            self._respond(
                req_id,
                error={"code": ERROR_INVALID_REQUEST, "message": "shutdown was already received."},
            )
            return
        self._phase = "shuttingDown"
        self._abort_all()
        for hook in self._shutdown_hooks:
            try:
                hook()
            except Exception as exc:
                self._write_stderr_category("shutdown_hook_failed", type(exc).__name__)
                self.diagnostics.terminal("shutdown", "internal_error", 0)
        self._respond(req_id, result=None)

    def _invoke_function(self, req_id: Any, token: CancelToken, raw_params: Any) -> None:
        if not isinstance(raw_params, dict):
            self._respond(req_id, error={"code": ERROR_INVALID_PARAMS, "message": "Function invoke requires object params."})
            return
        fn_id = raw_params.get("functionID")
        handler = self._functions.get(fn_id) if self._functions_version is not None and isinstance(fn_id, str) else None
        if handler is None:
            self._respond(
                req_id,
                error={"code": ERROR_INVALID_PARAMS, "message": "The requested plugin function is not registered."},
            )
            return

        op_id = raw_params.get("operationID")
        call_params = raw_params.get("params")
        if call_params is None:
            call_params = {}
        if not isinstance(call_params, dict):
            self._respond(req_id, error={"code": ERROR_INVALID_PARAMS, "message": "Function params must be an object."})
            return
        ws_ctx = raw_params.get("context") if isinstance(raw_params.get("context"), dict) else None

        reporting = True

        def _progress(payload: dict[str, Any]) -> None:
            if not reporting or not isinstance(op_id, str) or not op_id:
                return
            report: dict[str, Any] = {"operationID": op_id}
            if "message" in payload:
                report["message"] = bounded_utf8(payload["message"], MAX_ERROR_MESSAGE_BYTES)
            if "percentage" in payload and isinstance(payload["percentage"], (int, float)):
                report["percentage"] = min(100, max(0, int(round(payload["percentage"]))))
            self._write_frame({"jsonrpc": "2.0", "method": "lithe/function/progress", "params": report})

        def _shape_function(value: Any) -> Any:
            encoded = json.dumps(value, ensure_ascii=False).encode("utf-8")
            if len(encoded) > MAX_FUNCTION_RESULT_BYTES:
                raise ValueError("Function result exceeds 1 MiB limit")
            return value

        def _stop_reporting() -> None:
            nonlocal reporting
            reporting = False

        self._execute_tracked(
            req_id=req_id,
            token=token,
            operation=fn_id,
            wire_op_id=op_id,
            invoke=lambda ctx: handler(call_params, ctx),
            shape=_shape_function,
            on_settled=_stop_reporting,
            progress_cb=_progress,
            workspace_context=ws_ctx,
            emit_logging=True,
        )

    def _invoke_build(self, req_id: Any, token: CancelToken, method: str, raw_params: Any) -> None:
        progressing = method in (
            "lithe/build/execute",
            "lithe/build/test",
            "lithe/build/prepareRun",
            "lithe/build/prepareDebug",
        )
        if not isinstance(raw_params, dict) or (progressing and not isinstance(raw_params.get("operationID"), str)):
            self._respond(
                req_id,
                error={"code": ERROR_INVALID_PARAMS, "message": "A build request needs object params and its wire operationID."},
            )
            return

        handler = self._build_handlers[method]
        op_id = raw_params.get("operationID")
        reporting = True

        def _progress(payload: dict[str, Any]) -> None:
            if not reporting or not progressing or not isinstance(op_id, str):
                return
            report: dict[str, Any] = {"operationID": op_id}
            if "message" in payload:
                report["message"] = bounded_utf8(payload["message"], MAX_BUILD_MESSAGE_BYTES)
            if "output" in payload:
                report["output"] = bounded_utf8(payload["output"], MAX_BUILD_OUTPUT_BYTES)
            if "percentage" in payload and isinstance(payload["percentage"], (int, float)):
                report["percentage"] = min(100, max(0, int(round(payload["percentage"]))))
            self._write_frame({"jsonrpc": "2.0", "method": "lithe/build/progress", "params": report})

        def _shape_build(result: Any) -> dict[str, Any]:
            if not isinstance(result, dict):
                raise ValueError(f"{method} must return a dict")
            expected_fmt = BUILD_FORMATS.get(method)
            doc = dict(result)
            if expected_fmt is not None:
                if doc.get("format") not in (None, expected_fmt):
                    raise ValueError(f"Unexpected format for {method}")
                if doc.get("version") not in (None, 0):
                    raise ValueError(f"Unexpected version for {method}")
                doc["format"] = expected_fmt
                doc["version"] = 0
            if method in ("lithe/build/execute", "lithe/build/test"):
                exit_code = doc.get("exitCode")
                output = doc.get("output")
                if (
                    isinstance(exit_code, bool)
                    or not isinstance(exit_code, int)
                    or exit_code < -2147483648
                    or exit_code > 2147483647
                    or not isinstance(output, str)
                ):
                    raise ValueError(f"{method} requires int32 exitCode and string output")
            encoded = json.dumps(doc, ensure_ascii=False).encode("utf-8")
            if len(encoded) > MAX_BUILD_RESULT_BYTES:
                raise ValueError(f"{method} exceeds 32 MiB build result limit")
            return doc

        def _stop_reporting() -> None:
            nonlocal reporting
            reporting = False

        self._execute_tracked(
            req_id=req_id,
            token=token,
            operation=method,
            wire_op_id=op_id,
            invoke=lambda ctx: handler(raw_params, ctx),
            shape=_shape_build,
            on_settled=_stop_reporting,
            progress_cb=_progress if progressing else None,
            workspace_context=None,
            emit_logging=True,
        )


    def _execute_tracked(
        self,
        *,
        req_id: Any,
        token: CancelToken,
        operation: str,
        wire_op_id: Any,
        invoke: Callable[[CallContext], Any],
        shape: Callable[[Any], Any],
        on_settled: Callable[[], None],
        progress_cb: Optional[Callable[[dict[str, Any]], None]],
        workspace_context: Optional[dict[str, Any]],
        emit_logging: bool,
    ) -> None:
        started = time.monotonic()
        diag = self._make_diagnostics(request_operation_id(wire_op_id, req_id))
        quiet_call = False

        def _suppress() -> None:
            nonlocal quiet_call
            quiet_call = True

        ctx = CallContext(
            cancel_token=token,
            diagnostics=diag,
            suppress_cb=_suppress,
            operation_id=wire_op_id if isinstance(wire_op_id, str) else None,
            progress_cb=progress_cb,
            workspace_context=workspace_context,
        )

        result_val: Any = None
        error_obj: Optional[dict[str, Any]] = None
        diag_error_code: Optional[str] = None
        was_cancelled = False

        try:
            token.raise_if_cancelled()
            raw_value = invoke(ctx)
            result_val = shape(raw_value)
            token.raise_if_cancelled()
        except CancelledError:
            was_cancelled = True
            error_obj = {"code": ERROR_REQUEST_CANCELLED, "message": "The request was cancelled."}
        except PluginError as p_err:
            if token.cancelled:
                was_cancelled = True
                error_obj = {"code": ERROR_REQUEST_CANCELLED, "message": "The request was cancelled."}
            else:
                diag_error_code = p_err.code
                error_obj = {
                    "code": ERROR_REQUEST_FAILED,
                    "message": p_err.user_message,
                    "data": {"code": p_err.code},
                }
        except Exception as exc:
            if token.cancelled:
                was_cancelled = True
                error_obj = {"code": ERROR_REQUEST_CANCELLED, "message": "The request was cancelled."}
            else:
                self._write_stderr_category("request_failed", type(exc).__name__)
                diag_error_code = "internal_error"
                error_obj = {
                    "code": ERROR_INTERNAL,
                    "message": "The plugin backend failed unexpectedly.",
                }
        finally:
            elapsed_ms = (time.monotonic() - started) * 1000.0
            on_settled()

        # Emit terminal lithe/log notification strictly BEFORE the RPC response frame
        # so Core correlates wire operationId with the still-active host operation.
        if emit_logging and not was_cancelled:
            if error_obj is not None:
                diag.terminal(operation, diag_error_code or "internal_error", elapsed_ms)
            elif not quiet_call and operation not in self._quiet_success:
                diag.terminal(operation, None, elapsed_ms)

        self._respond(req_id, result=result_val, error=error_obj)
