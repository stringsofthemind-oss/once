from once_agent import Once
from main import refund_order

a = Once.id("refund", "order_123")
b = Once.id("refund", "order_123")
c = Once.id("refund", "order_124")

print("CrewAI tool creation:", "PASS" if refund_order is not None else "FAIL")
print("Stable Once identity:", "PASS" if a == b else "FAIL")
print("Distinct Once identity:", "PASS" if a != c else "FAIL")
print("Tool name:", getattr(refund_order, "name", "unknown"))
