import hashlib
import json
import os
import socket
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional


DEFAULT_BASE_URL = "https://once-q18-cloud.pennywatch.workers.dev"


class OnceError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        code: Optional[str] = None,
        body: Any = None,
        retry_after: Optional[float] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body
        self.retry_after = retry_after


class OnceTimeoutError(OnceError):
    def __init__(self, message: str = "Once request timed out") -> None:
        super().__init__(
            message,
            code="timeout",
        )


class OnceNetworkError(OnceError):
    def __init__(self, message: str = "Could not reach Once") -> None:
        super().__init__(
            message,
            code="network_error",
        )


class Once:
    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        timeout: float = 10.0,
        network_retries: int = 2,
    ) -> None:

        self.api_key = api_key or os.getenv("ONCE_API_KEY")

        if not self.api_key:
            raise OnceError(
                "Missing Once API key. Set ONCE_API_KEY or pass api_key.",
                code="missing_api_key",
            )

        self.base_url = (
            base_url
            or os.getenv("ONCE_BASE_URL")
            or DEFAULT_BASE_URL
        ).rstrip("/")

        self.timeout = timeout
        self.network_retries = network_retries


    @staticmethod
    def id(*parts: Any) -> str:
        """
        Generate a deterministic Once operation ID.

        Same inputs -> same operation ID.

        Parts must be strings or JavaScript-safe
        integral numbers.
        """

        if not parts:
            raise OnceError(
                "Once.id() requires at least one value.",
                code="invalid_operation_id",
            )

        values = []

        max_safe_integer = 9007199254740991

        for part in parts:

            if isinstance(part, str):
                values.append(part)
                continue

            if isinstance(part, bool):
                raise OnceError(
                    "Once.id() parts must be strings or safe integers.",
                    code="invalid_operation_id",
                )

            if isinstance(part, int):
                if abs(part) <= max_safe_integer:
                    values.append(str(part))
                    continue

                raise OnceError(
                    "Once.id() parts must be strings or safe integers.",
                    code="invalid_operation_id",
                )

            if isinstance(part, float):
                if (
                    part.is_integer()
                    and abs(part) <= max_safe_integer
                ):
                    values.append(str(int(part)))
                    continue

                raise OnceError(
                    "Once.id() parts must be strings or safe integers.",
                    code="invalid_operation_id",
                )

            raise OnceError(
                "Once.id() parts must be strings or safe integers.",
                code="invalid_operation_id",
            )

        # Once operation-ID semantic encoding v1.
        #
        # Hash input:
        #   b"once-id-v1\\x00"
        #   uint32be(part count)
        #   repeated:
        #     uint32be(UTF-8 byte length)
        #     UTF-8 bytes
        #
        # Length-prefixing prevents different part
        # boundaries from producing identical hash input.

        hasher = hashlib.sha256()

        hasher.update(
            b"once-id-v1\x00"
        )

        hasher.update(
            len(values).to_bytes(
                4,
                "big",
            )
        )

        for value in values:

            encoded = value.encode(
                "utf-8"
            )

            if len(encoded) > 0xffffffff:
                raise OnceError(
                    "Once.id() part is too large.",
                    code="invalid_operation_id",
                )

            hasher.update(
                len(encoded).to_bytes(
                    4,
                    "big",
                )
            )

            hasher.update(
                encoded
            )

        digest = hasher.hexdigest()[:32]

        prefix = "".join(
            (
                chr(ord(ch) + 32)
                if "A" <= ch <= "Z"
                else ch
            )
            for ch in values[0]
        )

        import re

        prefix = re.sub(
            r"[^a-z0-9._:-]+",
            "-",
            prefix,
        )

        prefix = re.sub(
            r"^[^a-z0-9]+",
            "",
            prefix,
        )

        prefix = prefix.rstrip("-")[:48]

        if not prefix:
            prefix = "operation"

        return f"{prefix}:{digest}"


    def execute(
        self,
        *,
        operation_id: str,
        provider: str,
        action: Dict[str, Any],
    ) -> Dict[str, Any]:

        if not operation_id:
            raise OnceError(
                "operation_id is required.",
                code="invalid_operation_id",
            )

        if not provider:
            raise OnceError(
                "provider is required.",
                code="invalid_provider",
            )

        return self._request(
            "/v1/execute",
            method="POST",
            body={
                "operation_id": operation_id,
                "provider": provider,
                "action": action,
            },
        )


    def truth(
        self,
        operation_id: str,
    ) -> Dict[str, Any]:

        if not operation_id:
            raise OnceError(
                "operation_id is required.",
                code="invalid_operation_id",
            )

        from urllib.parse import quote

        encoded_id = quote(
            operation_id,
            safe="",
        )

        return self._request(
            f"/v1/truth/{encoded_id}",
            method="GET",
        )


    def _request(
        self,
        path: str,
        *,
        method: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:

        payload = None

        if body is not None:
            payload = json.dumps(
                body,
                separators=(",", ":"),
            ).encode("utf-8")

        last_error: Optional[Exception] = None

        for attempt in range(
            self.network_retries + 1
        ):

            request = urllib.request.Request(
                f"{self.base_url}{path}",
                data=payload,
                method=method,
                headers={
                    "Authorization":
                        f"Bearer {self.api_key}",
                    "Content-Type":
                        "application/json",
                    "Accept":
                        "application/json",
                    "User-Agent":
                        "once-agent-python/0.1.0",
                },
            )

            try:
                with urllib.request.urlopen(
                    request,
                    timeout=self.timeout,
                ) as response:

                    raw = response.read().decode(
                        "utf-8"
                    )

                    if not raw:
                        return {}

                    return json.loads(raw)


            except urllib.error.HTTPError as exc:

                raw = exc.read().decode(
                    "utf-8",
                    errors="replace",
                )

                try:
                    parsed = (
                        json.loads(raw)
                        if raw
                        else {}
                    )
                except json.JSONDecodeError:
                    parsed = {
                        "message": raw
                    }

                retry_after = None

                header = exc.headers.get(
                    "Retry-After"
                )

                if header is not None:
                    try:
                        retry_after = float(
                            header
                        )
                    except ValueError:
                        pass

                code = (
                    parsed.get("error")
                    or parsed.get("result")
                    or f"http_{exc.code}"
                )

                message = (
                    parsed.get("message")
                    or parsed.get("error")
                    or parsed.get("result")
                    or f"Once returned HTTP {exc.code}"
                )

                raise OnceError(
                    str(message),
                    status=exc.code,
                    code=str(code),
                    body=parsed,
                    retry_after=retry_after,
                )


            except (
                urllib.error.URLError,
                socket.timeout,
                TimeoutError,
            ) as exc:

                last_error = exc

                if attempt < self.network_retries:
                    time.sleep(
                        0.15 * (2 ** attempt)
                    )
                    continue

                reason = getattr(
                    exc,
                    "reason",
                    None,
                )

                if (
                    isinstance(
                        exc,
                        (socket.timeout, TimeoutError),
                    )
                    or isinstance(
                        reason,
                        socket.timeout,
                    )
                ):
                    raise OnceTimeoutError(
                        f"Once request timed out after {self.timeout}s"
                    ) from exc

                raise OnceNetworkError(
                    "Could not reach Once after safe network retries"
                ) from exc


        raise OnceNetworkError(
            "Could not reach Once"
        ) from last_error


__all__ = [
    "Once",
    "OnceError",
    "OnceTimeoutError",
    "OnceNetworkError",
]
