"""Agno hostile-retry evidence for Once.

This reproduces agno-agi/agno#10366 with a deterministic loopback model:
- one caller-issued agent run
- three Agno retry attempts
- fresh tool_call_id on each attempt
- the tool completes before the following model request fails

The same Agno run is exercised twice:
1. control: the external effect boundary executes directly
2. once: the external effect boundary is protected by published @once-agent/sdk@0.1.12

The logical operation identity is caller-owned and captured outside model output.
The assertion is the durable external-effect count, not the final Agno run status.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

from agno.agent import Agent
from agno.models.openai.like import OpenAILike

ROOT = Path(__file__).resolve().parent
CALLER_OPERATION_ID = "caller-checkout-0001"
CARD_REF = "card-test-42"
EXPECTED_TOOL_CALL_IDS = ["call_1", "call_3", "call_5"]


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def get_json(url: str, timeout: float = 2.0) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def post_json(url: str, body: dict[str, Any], timeout: float = 5.0) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def start_sidecar(mode: str, workdir: Path) -> tuple[subprocess.Popen[str], str]:
    port = free_port()
    env = os.environ.copy()
    env.update(
        {
            "ONCE_AGNO_PORT": str(port),
            "ONCE_AGNO_MODE": mode,
            "ONCE_AGNO_LEDGER_PATH": str(workdir / "effects.jsonl"),
            "ONCE_AGNO_STATE_PATH": str(workdir / "once-state.sqlite"),
        }
    )

    process = subprocess.Popen(
        ["node", str(ROOT / "sidecar.mjs")],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    base_url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 10
    last_error: Exception | None = None

    while time.time() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise RuntimeError(
                f"sidecar exited early ({process.returncode})\nstdout:\n{stdout}\nstderr:\n{stderr}"
            )
        try:
            health = get_json(f"{base_url}/health")
            if health.get("ok") is True and health.get("mode") == mode:
                return process, base_url
        except Exception as error:  # loopback startup race only
            last_error = error
            time.sleep(0.05)

    process.terminate()
    stdout, stderr = process.communicate(timeout=5)
    raise RuntimeError(
        f"sidecar did not become healthy: {last_error}\nstdout:\n{stdout}\nstderr:\n{stderr}"
    )


def stop_sidecar(process: subprocess.Popen[str]) -> tuple[str, str]:
    if process.poll() is None:
        process.terminate()
    try:
        return process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        return process.communicate(timeout=5)


def make_scripted_model_server() -> tuple[HTTPServer, dict[str, Any], str]:
    state: dict[str, Any] = {"calls": 0, "tool_call_ids": []}

    class ScriptedModel(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
            length = int(self.headers.get("content-length", 0))
            self.rfile.read(length)

            state["calls"] += 1
            n = int(state["calls"])

            if n % 2 == 0:
                payload = json.dumps({"error": {"message": "upstream failure"}}).encode()
                self.send_response(500)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            call_id = f"call_{n}"
            state["tool_call_ids"].append(call_id)
            body = {
                "id": f"chatcmpl-{n}",
                "object": "chat.completion",
                "created": 0,
                "model": "scripted",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": call_id,
                                    "type": "function",
                                    "function": {
                                        "name": "charge_card",
                                        # Deliberately no operation_id here. The model does
                                        # not own or regenerate the Once identity.
                                        "arguments": json.dumps({"amount": "100.00"}),
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
                "usage": {
                    "prompt_tokens": 1,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                },
            }
            payload = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args: Any) -> None:
            return

    port = free_port()
    server = HTTPServer(("127.0.0.1", port), ScriptedModel)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, state, f"http://127.0.0.1:{port}/v1"


def run_case(mode: str, workdir: Path) -> dict[str, Any]:
    sidecar, sidecar_url = start_sidecar(mode, workdir)
    model_server, model_state, model_url = make_scripted_model_server()
    tool_invocations = 0

    def charge_card(amount: str) -> str:
        """Charge the caller-selected card for the requested amount."""
        nonlocal tool_invocations
        tool_invocations += 1
        result = post_json(
            f"{sidecar_url}/charge",
            {
                "operationId": CALLER_OPERATION_ID,
                "amount": amount,
                "cardRef": CARD_REF,
            },
        )
        return json.dumps(result, sort_keys=True)

    run_status = None
    run_content = None
    run_exception = None

    try:
        agent = Agent(
            model=OpenAILike(
                id="scripted",
                api_key="not-needed",
                base_url=model_url,
                max_retries=0,
            ),
            tools=[charge_card],
            retries=2,
            delay_between_retries=0,
        )
        output = agent.run("charge the card")
        run_status = str(getattr(output, "status", None))
        run_content = str(getattr(output, "content", None))
    except Exception as error:  # Agno versions may surface terminal failure differently.
        run_exception = f"{type(error).__name__}: {error}"
    finally:
        model_server.shutdown()
        model_server.server_close()

    stats = get_json(f"{sidecar_url}/stats")
    stdout, stderr = stop_sidecar(sidecar)

    return {
        "mode": mode,
        "caller_operation_id": CALLER_OPERATION_ID,
        "model_requests": model_state["calls"],
        "tool_call_ids": model_state["tool_call_ids"],
        "agno_tool_invocations": tool_invocations,
        "sidecar_requests": stats["requests"],
        "external_effects": stats["effects"],
        "run_status": run_status,
        "run_content": run_content,
        "run_exception": run_exception,
        "sidecar_stdout": stdout.strip(),
        "sidecar_stderr": stderr.strip(),
    }


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    print("Agno hostile-retry evidence")
    print("  agno: 3.0.10")
    print("  openai: 3.16.2")
    print("  once: @once-agent/sdk@0.1.12")
    print(f"  caller-owned logical operation: {CALLER_OPERATION_ID}")
    print()

    with tempfile.TemporaryDirectory(prefix="once-agno-evidence-") as temp:
        root = Path(temp)
        control = run_case("control", root / "control")
        once = run_case("once", root / "once")

    require(control["tool_call_ids"] == EXPECTED_TOOL_CALL_IDS, "control call IDs did not vary as expected")
    require(once["tool_call_ids"] == EXPECTED_TOOL_CALL_IDS, "Once call IDs did not vary as expected")
    require(control["agno_tool_invocations"] == 3, "control did not reproduce three Agno tool invocations")
    require(once["agno_tool_invocations"] == 3, "Once path did not receive all three Agno tool invocations")
    require(control["sidecar_requests"] == 3, "control boundary did not receive three requests")
    require(once["sidecar_requests"] == 3, "Once boundary did not receive three requests")
    require(control["external_effects"] == 3, "control did not reproduce three external effects")
    require(once["external_effects"] == 1, "Once did not suppress replay to one external effect")

    evidence = {
        "claim": "same logical action; changing tool_call_id; one external effect with Once",
        "identity_source": "caller-owned; captured outside model output",
        "control": control,
        "once": once,
    }

    evidence_path = ROOT / "evidence.json"
    evidence_path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")

    print("mode      model calls  tool ids                 Agno tool calls  boundary calls  external effects")
    print("--------  -----------  -----------------------  ----------------  --------------  ----------------")
    for result in (control, once):
        ids = ",".join(result["tool_call_ids"])
        print(
            f"{result['mode']:<8}  {result['model_requests']:<11}  {ids:<23}  "
            f"{result['agno_tool_invocations']:<16}  {result['sidecar_requests']:<14}  "
            f"{result['external_effects']}"
        )

    print()
    print("PASS: Agno retried the tool three times in both runs.")
    print("PASS: tool_call_id changed across attempts: call_1, call_3, call_5.")
    print("PASS: control committed 3 external effects.")
    print("PASS: Once received the same 3 calls and committed 1 external effect.")
    print(f"Evidence: {evidence_path}")


if __name__ == "__main__":
    main()
