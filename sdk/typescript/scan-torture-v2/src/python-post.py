import requests

def create_remote_order():
    return requests.post(
        "https://example.com/orders",
        json={"sku": "A1"}
    )
