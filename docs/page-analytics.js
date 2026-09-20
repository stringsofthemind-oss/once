(() => {
  "use strict";

  const ENDPOINT =
    "https://once-sandbox-playground.pennywatch.workers.dev/analytics/event";

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