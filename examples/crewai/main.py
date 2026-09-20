import json
import os

from crewai import Agent, Crew, Process, Task
from crewai.tools import tool
from dotenv import load_dotenv
from once_agent import Once


load_dotenv()


@tool("Refund Order")
def refund_order(order_id: str) -> str:
    """Issue a consequential refund through Once using stable operation identity."""

    provider = os.getenv("ONCE_PROVIDER_ALIAS")

    if not provider:
        raise RuntimeError("Set ONCE_PROVIDER_ALIAS before running the refund tool.")

    once = Once()
    operation_id = Once.id("refund", order_id)

    result = once.execute(
        operation_id=operation_id,
        provider=provider,
        action={
            "type": "refund",
            "order_id": order_id,
        },
    )

    return json.dumps(result, sort_keys=True)


def build_crew() -> Crew:
    agent = Agent(
        role="Refund Operations Agent",
        goal="Process requested refunds without blindly duplicating consequential actions.",
        backstory=(
            "You handle refund requests. Consequential writes must use the supplied "
            "Refund Order tool so retries retain the same logical operation identity."
        ),
        tools=[refund_order],
        allow_delegation=False,
        verbose=True,
    )

    task = Task(
        description=(
            "Process the refund request for order {order_id}. "
            "Use the Refund Order tool for the consequential action."
        ),
        expected_output="A concise report describing the refund operation result.",
        agent=agent,
    )

    return Crew(
        agents=[agent],
        tasks=[task],
        process=Process.sequential,
        verbose=True,
    )


if __name__ == "__main__":
    order_id = os.getenv("ORDER_ID", "order_123")
    result = build_crew().kickoff(inputs={"order_id": order_id})
    print(result)
