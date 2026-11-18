"""Exercise Python request cancellation and child ownership with bounded handshakes."""

import io
from pathlib import Path
import os
import signal
import socket
import subprocess
import sys
import threading
import unittest

sys.path.insert(0, sys.argv.pop(1))
from lithe_rpc import CancelToken, CancelledError, FrameDecoder, JsonRpcServer, run_bounded_process


class DeferredExecutor:
    def __init__(self):
        self.tasks = []

    def submit(self, callback, *args):
        self.tasks.append((callback, args))

    def run(self):
        callback, args = self.tasks.pop(0)
        callback(*args)


class CancellationTests(unittest.TestCase):
    def test_cancel_before_worker_starts(self):
        invoked = []
        server = JsonRpcServer(name="cancellation-test")
        server._executor.shutdown()
        server._executor = DeferredExecutor()
        server._phase = "ready"
        server._functions_version = 0
        server._output_stream = io.BytesIO()
        server.function("test.call", lambda params, context: invoked.append(True))
        server._dispatch({
            "jsonrpc": "2.0", "id": 1, "method": "lithe/function/invoke",
            "params": {"functionID": "test.call", "params": {}},
        })
        server._dispatch({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": 1}})
        server._executor.run()
        response, = FrameDecoder().push(server._output_stream.getvalue())
        self.assertEqual(invoked, [])
        self.assertEqual(response["error"]["code"], -32800)

    def test_worker_closes_descendants_on_cancel_or_parent_exit(self):
        child = """
import os, signal, socket, sys, threading
if os.name != 'nt':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
with socket.create_connection(('127.0.0.1', int(sys.argv[1])), timeout=5) as conn:
    conn.sendall(str(os.getpid()).encode('ascii') + b'\\n')
    print('ready', flush=True)
    threading.Event().wait(20)
"""
        parent = """
import subprocess, sys
process = subprocess.Popen([sys.executable, '-I', '-B', '-c', sys.argv[1], sys.argv[2]],
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
try:
    assert process.stdout.readline() == b'ready\\n'
    if sys.argv[3] == 'cancel':
        process.wait(timeout=20)
finally:
    process.stdout.close()
"""
        for mode in ("cancel", "exit"):
            with self.subTest(mode=mode), socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen()
                listener.settimeout(5)
                token = CancelToken()
                result = []

                def run():
                    try:
                        result.append(run_bounded_process(
                            [sys.executable, "-I", "-B", "-c", parent, child,
                             str(listener.getsockname()[1]), mode],
                            cwd=str(Path.cwd()),
                            env=dict(os.environ),
                            cancel_token=token,
                            timeout_seconds=10,
                        ))
                    except Exception as error:
                        result.append(error)

                worker = threading.Thread(target=run, daemon=True)
                worker.start()
                pid = None
                try:
                    conn, _address = listener.accept()
                    with conn, conn.makefile("rb") as ready:
                        conn.settimeout(5)
                        pid = int(ready.readline(32))
                        if mode == "cancel":
                            token.cancel()
                        worker.join(6)
                        self.assertFalse(worker.is_alive(), "subprocess cleanup did not finish")
                        try:
                            self.assertEqual(ready.read(1), b"", "descendant still owns its connection")
                        except ConnectionResetError:
                            # Job termination can close a Windows socket with
                            # a reset instead of an orderly end-of-stream.
                            if os.name != "nt":
                                raise
                        pid = None
                    if mode == "cancel":
                        self.assertIsInstance(result[0], CancelledError)
                    else:
                        self.assertEqual(result, [(0, "", False)])
                finally:
                    token.cancel()
                    if pid is not None:
                        try:
                            os.kill(pid, signal.SIGTERM if os.name == "nt" else signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    worker.join(6)


if __name__ == "__main__":
    unittest.main()
