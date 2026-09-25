(() => {
  "use strict";

  // Kept in lockstep with package metadata by
  // scripts/check-site-surface.mjs.
  const SITE_VERSIONS = Object.freeze({
    ts: "0.1.11",
    python: "0.1.1",
    mcp: "0.1.3"
  });

  const releaseLine =
    `TS SDK ${SITE_VERSIONS.ts} · PY SDK ${SITE_VERSIONS.python} · MCP ${SITE_VERSIONS.mcp}`;

  const status = document.querySelector(".status");

  if (status) {
    const dot = status.querySelector("i");

    status.replaceChildren();

    if (dot) {
      status.append(dot);
    }

    status.append(
      document.createTextNode(` ${releaseLine}`)
    );
  }

  const footerVersion =
    document.querySelector("footer > span:last-child");

  if (footerVersion) {
    footerVersion.textContent = releaseLine;
  }

  const schema =
    document.querySelector(
      'script[type="application/ld+json"]'
    );

  if (schema) {
    try {
      const data = JSON.parse(
        schema.textContent || "{}"
      );

      if (
        data &&
        data["@type"] === "SoftwareApplication"
      ) {
        data.softwareVersion = SITE_VERSIONS.ts;
        schema.textContent = JSON.stringify(data, null, 2);
      }
    } catch {
      // Metadata repair is non-critical to page rendering.
    }
  }

  // --------------------------------------------------------
  // ONCE HEARTBEAT VISIBILITY OVERRIDE
  // --------------------------------------------------------
  // The base stylesheet owns cadence and reduced-motion policy.
  // This late override only makes the 1-second ambient heartbeat
  // unmistakably visible and gives it the Once red heartbeat colour.

  const heartbeatStyle = document.createElement("style");
  heartbeatStyle.dataset.onceHeartbeat = "red-visible-v2";
  heartbeatStyle.textContent = `
.once-network::before{
  width:210px;
  height:150px;
  background:
    radial-gradient(
      ellipse,
      rgba(255,59,77,.62) 0%,
      rgba(255,59,77,.34) 34%,
      rgba(255,59,77,.13) 58%,
      rgba(255,59,77,0) 80%
    ) !important;
  box-shadow:
    0 0 30px rgba(255,59,77,.24),
    0 0 58px rgba(255,59,77,.12);
  filter:blur(1px);
}

.once-network-value{
  text-shadow:
    0 0 28px rgba(255,59,77,.20);
}

@keyframes once-network-heartbeat{
  0%,100%{
    opacity:.44;
    transform:
      translate(-50%,-50%)
      scale(.86);
  }

  50%{
    opacity:.94;
    transform:
      translate(-50%,-50%)
      scale(1.08);
  }
}
`;
  document.head.append(heartbeatStyle);

  // --------------------------------------------------------
  // LIVE COUNTER LAST-KNOWN FALLBACK
  // --------------------------------------------------------

  const COUNTER_STORAGE_KEY =
    "onceLastKnownProtectedOperations";

  const networkValue =
    document.getElementById("once-network-value");

  const networkLabel =
    document.getElementById("once-network-label");

  const networkStatus =
    document.getElementById("once-network-status");

  function readStoredCount() {
    try {
      const raw = localStorage.getItem(
        COUNTER_STORAGE_KEY
      );

      if (raw === null) {
        return null;
      }

      const count = Number(raw);

      return Number.isSafeInteger(count) && count >= 0
        ? count
        : null;
    } catch {
      return null;
    }
  }

  function storeCount(count) {
    try {
      localStorage.setItem(
        COUNTER_STORAGE_KEY,
        String(count)
      );
    } catch {
      // Storage is optional.
    }
  }

  function renderLastKnown(statusText) {
    if (!networkValue || !networkLabel || !networkStatus) {
      return;
    }

    const stored = readStoredCount();

    if (stored === null) {
      return;
    }

    networkValue.textContent =
      stored.toLocaleString();

    networkLabel.textContent =
      stored === 1
        ? "protected operation"
        : "protected operations";

    networkStatus.textContent = statusText;
  }

  if (networkValue && networkStatus) {
    if (
      networkValue.textContent?.trim() === "—"
    ) {
      renderLastKnown(
        "LAST KNOWN • CONNECTING LIVE"
      );
    }

    const observeCounter = () => {
      const statusText =
        networkStatus.textContent?.trim() || "";

      const rawValue =
        (networkValue.textContent || "")
          .replaceAll(",", "")
          .trim();

      const count = Number(rawValue);

      if (
        statusText === "LIVE • PRODUCTION COUNTER" &&
        Number.isSafeInteger(count) &&
        count >= 0
      ) {
        storeCount(count);
        return;
      }

      if (
        statusText === "LIVE TELEMETRY UNAVAILABLE"
      ) {
        renderLastKnown(
          "LAST KNOWN • RETRYING LIVE"
        );
      }
    };

    const counterObserver =
      new MutationObserver(observeCounter);

    counterObserver.observe(
      networkValue,
      {
        childList: true,
        characterData: true,
        subtree: true
      }
    );

    counterObserver.observe(
      networkStatus,
      {
        childList: true,
        characterData: true,
        subtree: true
      }
    );

    observeCounter();
  }

  const ENDPOINT =
    "https://playground.onceexec.com/analytics/event";

  fetch(
    ENDPOINT,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        event: "page_view",
        source: "website"
      }),
      keepalive: true
    }
  ).catch(() => {
    // Analytics must never interfere with the page.
  });
})();