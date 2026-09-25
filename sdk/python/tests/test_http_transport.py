from __future__ import annotations

import json
import socket
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from once_agent import Once, OnceError, OnceTimeoutError


class _State:
    def __init__(self):
        self.mode = "ok"
        self.requests = 0
        self.redirect_effects = 0
        self.peer_ports = []
        self.lock = threading.Lock()


class _QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Timeout tests intentionally disconnect before
        # the delayed handler attempts to write.
        pass


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    @property
    def state(self):
        return self.server.state

    def _record(self):
        with self.state.lock:
            self.state.requests += 1
            self.state.peer_ports.append(
                self.client_address[1]
            )
            return self.state.requests

    def _send_json(self, status, body, headers=None):
        payload = json.dumps(
            body,
            separators=(",", ":"),
        ).encode("utf-8")

        self.send_response(status)
        self.send_header(
            "Content-Type",
            "application/json",
        )
        self.send_header(
            "Content-Length",
            str(len(payload)),
        )

        for name, value in (headers or {}).items():
            self.send_header(name, value)

        self.end_headers()

        if payload:
            self.wfile.write(payload)

    def do_GET(self):
        request_number = self._record()

        if self.path == "/effect":
            with self.state.lock:
                self.state.redirect_effects += 1

            self._send_json(
                200,
                {"effect": True},
            )
            return

        if self.state.mode == "delay":
            time.sleep(0.20)

        if (
            self.state.mode == "drop_once"
            and request_number == 1
        ):
            self.close_connection = True

            try:
                self.connection.shutdown(
                    socket.SHUT_RDWR
                )
            except OSError:
                pass

            self.connection.close()
            return

        if self.state.mode == "rate_limit":
            self._send_json(
                429,
                {
                    "error": "slow_down",
                    "message": "wait",
                },
                {
                    "Retry-After": "2"
                },
            )
            return

        self._send_json(
            200,
            {
                "ledger_state": "CONFIRMED",
                "state": "CONFIRMED",
                "side_effects": 1,
            },
        )

    def do_POST(self):
        self._record()

        length = int(
            self.headers.get(
                "Content-Length",
                "0",
            )
        )

        if length:
            self.rfile.read(length)

        if self.state.mode == "redirect":
            self.send_response(302)
            self.send_header(
                "Location",
                "/effect",
            )
            self.send_header(
                "Content-Length",
                "0",
            )
            self.end_headers()
            return

        self._send_json(
            200,
            {
                "result": "already_executed",
                "state": "CONFIRMED",
                "side_effects": 1,
            },
        )


@contextmanager
def _server(mode="ok"):
    server = _QuietServer(
        ("127.0.0.1", 0),
        _Handler,
    )
    server.state = _State()
    server.state.mode = mode

    thread = threading.Thread(
        target=server.serve_forever,
        daemon=True,
    )
    thread.start()

    try:
        yield (
            "http://127.0.0.1:"
            + str(server.server_address[1]),
            server.state,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _once(
    base_url,
    *,
    timeout=1.0,
    network_retries=0,
):
    # Local regression traffic must not escape
    # through a machine proxy.
    with (
        patch(
            "once_agent.urllib.request.proxy_bypass",
            return_value=True,
        ),
        patch(
            "once_agent.urllib.request.getproxies",
            return_value={},
        ),
    ):
        return Once(
            api_key="once_test_transport",
            base_url=base_url,
            timeout=timeout,
            network_retries=network_retries,
        )


class HttpTransportTest(unittest.TestCase):
    def test_reuses_persistent_connection(self):
        with _server() as (base_url, state):
            once = _once(base_url)

            try:
                once.truth("one")
                once.truth("two")
            finally:
                once.close()

            self.assertGreaterEqual(
                len(state.peer_ports),
                2,
            )
            self.assertEqual(
                state.peer_ports[0],
                state.peer_ports[1],
                "expected the second request to reuse the first TCP connection",
            )

    def test_redirect_is_blocked_without_following(self):
        with _server("redirect") as (
            base_url,
            state,
        ):
            once = _once(base_url)

            try:
                with self.assertRaises(
                    OnceError
                ) as captured:
                    once.execute(
                        operation_id="redirect:test",
                        provider="blind_test",
                        action={"x": 1},
                    )
            finally:
                once.close()

            self.assertEqual(
                captured.exception.status,
                302,
            )
            self.assertEqual(
                captured.exception.code,
                "redirect_blocked",
            )
            self.assertEqual(
                state.redirect_effects,
                0,
                "redirect target must never be followed",
            )

    def test_http_error_and_retry_after_are_preserved(self):
        with _server("rate_limit") as (
            base_url,
            _,
        ):
            once = _once(base_url)

            try:
                with self.assertRaises(
                    OnceError
                ) as captured:
                    once.truth("rate:test")
            finally:
                once.close()

            self.assertEqual(
                captured.exception.status,
                429,
            )
            self.assertEqual(
                captured.exception.code,
                "slow_down",
            )
            self.assertEqual(
                captured.exception.retry_after,
                2.0,
            )

    def test_timeout_maps_to_once_timeout(self):
        with _server("delay") as (
            base_url,
            _,
        ):
            once = _once(
                base_url,
                timeout=0.05,
            )

            try:
                with self.assertRaises(
                    OnceTimeoutError
                ):
                    once.truth(
                        "timeout:test"
                    )
            finally:
                once.close()

    def test_once_owns_network_retry_policy(self):
        with _server("drop_once") as (
            base_url,
            state,
        ):
            once = _once(
                base_url,
                network_retries=1,
            )

            try:
                result = once.truth(
                    "retry:test"
                )
            finally:
                once.close()

            self.assertEqual(
                result["ledger_state"],
                "CONFIRMED",
            )
            self.assertEqual(
                state.requests,
                2,
                "urllib3 must not add hidden retries",
            )

    def test_shared_client_is_thread_safe(self):
        with _server() as (
            base_url,
            _,
        ):
            once = _once(base_url)

            try:
                with ThreadPoolExecutor(
                    max_workers=8
                ) as executor:
                    results = list(
                        executor.map(
                            lambda index:
                                once.truth(
                                    f"concurrent:{index}"
                                ),
                            range(16),
                        )
                    )
            finally:
                once.close()

            self.assertEqual(
                len(results),
                16,
            )
            self.assertTrue(
                all(
                    row["ledger_state"]
                    == "CONFIRMED"
                    for row in results
                )
            )


if __name__ == "__main__":
    unittest.main()
