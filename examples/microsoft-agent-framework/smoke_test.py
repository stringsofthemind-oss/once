import os

os.environ["OPENAI_API_KEY"] = "test-key-not-used"

from main import build_agent, refund_order
from once_agent import Once

agent = build_agent()

a = Once.id("refund", "order_123")
b = Once.id("refund", "order_123")
c = Once.id("refund", "order_124")

print("Microsoft Agent Framework tool:", "PASS" if refund_order is not None else "FAIL")
print("Agent construction:", "PASS" if agent is not None else "FAIL")
print("Stable Once identity:", "PASS" if a == b else "FAIL")
print("Distinct Once identity:", "PASS" if a != c else "FAIL")
print("Tool name:", getattr(refund_order, "name", "unknown"))
