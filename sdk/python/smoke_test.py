import sys
import uuid

sys.path.insert(0, r".\sdk\python\src")

from once_agent import Once

once = Once()

operation_id = "python-sdk-" + uuid.uuid4().hex

print("Operation:", operation_id)

first = once.execute(
    operation_id=operation_id,
    provider="blind_test",
    action={
        "type": "python_sdk_smoke_test"
    },
)

print("First:", first.get("result"))

retry = once.execute(
    operation_id=operation_id,
    provider="blind_test",
    action={
        "type": "python_sdk_smoke_test"
    },
)

print("Retry:", retry.get("result"))

truth = once.truth(operation_id)

print("State:", truth.get("ledger_state"))
print("Side effects:", truth.get("side_effects"))

if truth.get("side_effects") != 1:
    raise RuntimeError("SAFETY FAILURE")

print("PYTHON SDK SAFETY TEST PASSED")
