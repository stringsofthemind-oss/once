from __future__ import annotations

import importlib.metadata as metadata
import importlib.util
import os
from pathlib import Path

from once_agent import Once


EXPECTED_VERSION = "0.1.1"
EXPECTED_ID = "refund:52de488ac74e0e5846737490bdb401bb"
EXPECTED_USER_AGENT = "once-agent-python/0.1.1"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


dist = metadata.distribution("once-agent-sdk")
require(dist.version == EXPECTED_VERSION, f"unexpected installed version: {dist.version}")

requirements = [item.replace(" ", "") for item in (dist.requires or [])]
urllib3_requirements = [item for item in requirements if item.lower().startswith("urllib3")]
require(len(urllib3_requirements) == 1, f"unexpected urllib3 dependency metadata: {requirements}")
require(">=2.2" in urllib3_requirements[0], f"urllib3 lower bound missing: {urllib3_requirements[0]}")
require("<3" in urllib3_requirements[0], f"urllib3 upper bound missing: {urllib3_requirements[0]}")

spec = importlib.util.find_spec("once_agent")
require(spec is not None and spec.origin is not None, "once_agent import location unavailable")
origin = Path(spec.origin).resolve()
workspace = os.environ.get("GITHUB_WORKSPACE")
if workspace:
    require(
        not origin.is_relative_to(Path(workspace).resolve()),
        f"consumer proof imported repository source instead of installed PyPI package: {origin}",
    )

first = Once.id("refund", "order_123")
second = Once.id("refund", "order_123")
require(first == second, "Once.id() is not deterministic")
require(first == EXPECTED_ID, f"Once.id() conformance mismatch: {first}")


class FakeResponse:
    status = 200
    data = b"{}"
    headers: dict[str, str] = {}


class CaptureHTTP:
    def __init__(self) -> None:
        self.headers = None

    def request(self, method, url, **kwargs):
        self.headers = kwargs.get("headers")
        return FakeResponse()

    def clear(self) -> None:
        pass


client = Once(
    api_key="once_test_public_consumer",
    base_url="https://example.invalid",
    network_retries=0,
)
capture = CaptureHTTP()
client._http = capture
client.truth("consumer-proof")

require(capture.headers is not None, "request headers were not captured")
require(
    capture.headers.get("User-Agent") == EXPECTED_USER_AGENT,
    f"unexpected User-Agent: {capture.headers.get('User-Agent')}",
)

print("PASS once-agent-sdk public PyPI consumer")
print(f"version={dist.version}")
print(f"origin={origin}")
print(f"dependency={urllib3_requirements[0]}")
print(f"once_id={first}")
print(f"user_agent={capture.headers.get('User-Agent')}")
