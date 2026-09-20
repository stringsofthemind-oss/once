import asyncio
import json
import os

from agent_framework import Agent, tool
from agent_framework.openai import OpenAIChatClient
from dotenv import load_dotenv
from once_agent import Once


load_dotenv()


@tool(
    name="refund_order",
    description="Safely issue a consequential refund operation.",
)
def refund_order(order_id: str) -> str:
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


def build_agent() -> Agent:
    model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

    client = OpenAIChatClient(model=model)

    return Agent(
        client=client,
        name="refund-agent",
        instructions=(
            "You process refund requests. Use the refund_order tool for "
            "consequential refund actions so retries retain stable operation identity."
        ),
        tools=[refund_order],
    )


async def main() -> None:
    order_id = os.getenv("ORDER_ID", "order_123")
    agent = build_agent()

    response = await agent.run(
        f"Process the refund request for order {order_id} using the refund tool."
    )

    print(response)


if __name__ == "__main__":
    asyncio.run(main())
