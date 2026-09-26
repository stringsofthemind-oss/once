(() => {
  "use strict";

  // Kept in lockstep with package metadata by
  // scripts/check-site-surface.mjs.
  const SITE_VERSIONS = Object.freeze({
    ts: "0.1.12",
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
  // ONCE PULSE
  // --------------------------------------------------------
  // Keep the one-second heartbeat cadence, but show only the
  // compact pulse mark behind the live counter. The long ECG
  // baseline is intentionally removed. A real protected-operation
  // increase still uses the contrasting cyan event ripple.

  const heartbeatStyle = document.createElement("style");
  heartbeatStyle.dataset.onceHeartbeat = "pulse-only-v5";
  heartbeatStyle.textContent = `
.once-network::before{
  width:176px;
  height:112px;
  background:
    radial-gradient(
      ellipse,
      rgba(255,35,52,.46) 0%,
      rgba(255,35,52,.20) 35%,
      rgba(255,35,52,.06) 58%,
      rgba(255,35,52,0) 74%
    ) !important;
  box-shadow:
    0 0 22px rgba(255,35,52,.26),
    0 0 40px rgba(255,35,52,.12);
  filter:none;
}

.once-network-value-wrap{
  position:relative;
  isolation:isolate;
}

.once-heartbeat-monitor{
  position:absolute;
  z-index:0;
  left:50%;
  top:54%;
  width:min(112px,42%);
  height:72px;
  transform:translate(-50%,-50%);
  overflow:visible;
  pointer-events:none;
}

.once-heartbeat-monitor .trace{
  fill:none;
  stroke:#ff3040;
  stroke-width:2.6;
  stroke-linecap:round;
  stroke-linejoin:round;
  vector-effect:non-scaling-stroke;
  transform-origin:center;
  filter:
    drop-shadow(0 0 3px rgba(255,48,64,.95))
    drop-shadow(0 0 8px rgba(255,48,64,.46));
  animation:
    once-heartbeat-pulse
    1s
    ease-in-out
    infinite;
}

.once-network.operation-confirmed::after{
  border:2px solid #43d7ff !important;
  background:
    radial-gradient(
      circle,
      rgba(67,215,255,.24) 0%,
      rgba(67,215,255,.10) 42%,
      rgba(67,215,255,0) 72%
    );
  box-shadow:
    0 0 12px rgba(67,215,255,.96),
    0 0 30px rgba(67,215,255,.58),
    0 0 54px rgba(67,215,255,.28);
}

.once-network-value{
  position:relative;
  z-index:2;
  text-shadow:
    0 0 18px rgba(255,48,64,.22);
}

@keyframes once-network-heartbeat{
  0%,100%{
    opacity:.40;
    transform:
      translate(-50%,-50%)
      scale(.92);
  }

  50%{
    opacity:.78;
    transform:
      translate(-50%,-50%)
      scale(1.02);
  }
}

@keyframes once-heartbeat-pulse{
  0%,100%{
    opacity:.52;
    transform:scale(.96);
  }
  45%{
    opacity:1;
    transform:scale(1.04);
  }
}

@media(prefers-reduced-motion:reduce){
  .once-heartbeat-monitor .trace{
    animation:none;
  }
}
`;
  document.head.append(heartbeatStyle);

  const heartbeatHost =
    document.querySelector(".once-network-value-wrap");

  if (
    heartbeatHost &&
    !heartbeatHost.querySelector(".once-heartbeat-monitor")
  ) {
    const svg = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    );

    svg.setAttribute("class", "once-heartbeat-monitor");
    svg.setAttribute("viewBox", "0 0 112 72");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    const trace = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    );

    trace.setAttribute("class", "trace");
    trace.setAttribute(
      "d",
      "M20 38 L32 29 L43 51 L55 8 L67 61 L80 24 L92 38"
    );

    svg.append(trace);
    heartbeatHost.prepend(svg);
  }

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