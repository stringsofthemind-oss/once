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