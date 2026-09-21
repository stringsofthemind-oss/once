const reveals =
  document.querySelectorAll(".reveal");

const observer =
  new IntersectionObserver(
    (entries) => {

      for (const entry of entries) {

        if (entry.isIntersecting) {

          entry.target.classList.add("visible");

          observer.unobserve(entry.target);

        }

      }

    },
    {
      threshold: 0.12
    }
  );

for (const element of reveals) {
  observer.observe(element);
}


document
  .querySelectorAll("[data-copy]")
  .forEach((button) => {

    button.addEventListener(
      "click",
      async () => {

        const text =
          button.getAttribute("data-copy");

        try {

          await navigator.clipboard.writeText(text);

          const previous =
            button.textContent;

          button.textContent =
            "COPIED";

          setTimeout(
            () => {
              button.textContent = previous;
            },
            1300
          );

        } catch {

          button.textContent =
            "SELECT";

        }

      }
    );

  });


const glow =
  document.querySelector(".cursor-glow");

window.addEventListener(
  "pointermove",
  (event) => {

    glow.style.left =
      event.clientX + "px";

    glow.style.top =
      event.clientY + "px";

  },
  {
    passive: true
  }
);


// ==========================================================
// ONCE INTERACTION AUDIO
// ==========================================================

(() => {

  "use strict";

  const toggle =
    document.getElementById(
      "onceSoundToggle"
    );

  if (!toggle) {
    return;
  }


  // --------------------------------------------------------
  // PREFERENCE
  // --------------------------------------------------------

  const STORAGE_KEY =
    "onceInteractionSound";

  let enabled = true;


  try {

    if (
      localStorage.getItem(
        STORAGE_KEY
      ) === "off"
    ) {
      enabled = false;
    }

  } catch (_) {
    // Storage is optional.
  }


  function savePreference() {

    try {

      localStorage.setItem(
        STORAGE_KEY,
        enabled
          ? "on"
          : "off"
      );

    } catch (_) {
      // Storage is optional.
    }
  }


  function renderToggle() {

    toggle.dataset.sound =
      enabled
        ? "on"
        : "off";

    toggle.setAttribute(
      "aria-pressed",
      enabled
        ? "true"
        : "false"
    );

    const state =
      toggle.querySelector(
        ".once-sound-state"
      );

    if (state) {

      state.textContent =
        enabled
          ? "ON"
          : "OFF";
    }
  }


  renderToggle();


  // --------------------------------------------------------
  // AUDIO CONTEXT
  // --------------------------------------------------------

  let context = null;

  // Global Once UI sound level.
  // 1.10 = 10% louder than original tuning.
  const MASTER_VOLUME = 1.452;


  function audioContext() {

    if (!context) {

      const AudioContextClass =
        window.AudioContext ||
        window.webkitAudioContext;

      if (!AudioContextClass) {
        return null;
      }

      context =
        new AudioContextClass();
    }


    if (
      context.state ===
      "suspended"
    ) {

      context.resume()
        .catch(() => {});
    }


    return context;
  }


  // --------------------------------------------------------
  // QUIET SYNTH VOICE
  //
  // Deliberately low levels.
  // Short envelopes.
  // No hover or scroll audio.
  // --------------------------------------------------------

  function tone(
    frequency,
    duration,
    volume,
    type = "sine",
    delay = 0
  ) {

    if (!enabled) {
      return;
    }

    const ctx =
      audioContext();

    if (!ctx) {
      return;
    }


    const start =
      ctx.currentTime +
      delay;

    const end =
      start +
      duration;


    const oscillator =
      ctx.createOscillator();

    const gain =
      ctx.createGain();


    oscillator.type =
      type;

    oscillator.frequency.setValueAtTime(
      frequency,
      start
    );


    gain.gain.setValueAtTime(
      0.0001,
      start
    );

    gain.gain.exponentialRampToValueAtTime(
      volume * MASTER_VOLUME,
      start + 0.008
    );

    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      end
    );


    oscillator.connect(
      gain
    );

    gain.connect(
      ctx.destination
    );


    oscillator.start(
      start
    );

    oscillator.stop(
      end + 0.01
    );
  }


  // --------------------------------------------------------
  // PREMIUM TACTILE TICK
  // --------------------------------------------------------

  function tactileTick() {

    tone(
      210,
      0.038,
      0.010,
      "triangle"
    );

    tone(
      420,
      0.025,
      0.0045,
      "sine",
      0.006
    );
  }


  // --------------------------------------------------------
  // PRIMARY ACTION
  // --------------------------------------------------------

  function primaryPulse() {

    tone(
      310,
      0.055,
      0.010,
      "triangle"
    );

    tone(
      465,
      0.070,
      0.006,
      "sine",
      0.018
    );
  }


  // --------------------------------------------------------
  // EXTERNAL EVIDENCE
  //
  // Glass-like two-note discovery sound.
  // --------------------------------------------------------

  function evidenceChime() {

    tone(
      659.25,
      0.105,
      0.008,
      "sine"
    );

    tone(
      880,
      0.140,
      0.0065,
      "sine",
      0.058
    );
  }


  // --------------------------------------------------------
  // TESTER TELEMETRY
  // --------------------------------------------------------

  function telemetryPulse() {

    tone(
      392,
      0.052,
      0.0055,
      "sine"
    );
  }


  // --------------------------------------------------------
  // CONFIRMATION
  // --------------------------------------------------------

  function confirmationTone() {

    tone(
      523.25,
      0.085,
      0.008,
      "sine"
    );

    tone(
      783.99,
      0.125,
      0.0065,
      "sine",
      0.052
    );
  }


  // --------------------------------------------------------
  // SOUND TOGGLE
  // --------------------------------------------------------

  toggle.addEventListener(
    "click",
    () => {

      if (enabled) {

        tactileTick();

        enabled = false;

        savePreference();
        renderToggle();

        return;
      }


      enabled = true;

      savePreference();
      renderToggle();

      confirmationTone();
    }
  );


  // --------------------------------------------------------
  // INTERACTION ROUTER
  //
  // Event delegation means future Evidence Signals will
  // automatically inherit the sound language.
  // --------------------------------------------------------

  document.addEventListener(
    "click",
    (event) => {

      const target =
        event.target instanceof Element
          ? event.target
          : null;

      if (!target) {
        return;
      }


      if (
        target.closest(
          "#onceSoundToggle"
        )
      ) {
        return;
      }


      if (!enabled) {
        return;
      }


      // External fact / evidence links.
      if (
        target.closest(
          ".fact-link, " +
          ".evidence-link, " +
          "[data-once-sound='evidence']"
        )
      ) {

        evidenceChime();
        return;
      }


      // Copy-to-clipboard actions.
      if (
        target.closest(
          "[data-copy]"
        )
      ) {

        confirmationTone();
        return;
      }


      // Main calls to action.
      if (
        target.closest(
          ".button-primary"
        )
      ) {

        primaryPulse();
        return;
      }


      // Ordinary navigation / buttons.
      if (
        target.closest(
          "a, button"
        )
      ) {

        tactileTick();
      }
    },
    true
  );


  // --------------------------------------------------------
  // TESTER
  //
  // Only plays when a value is committed.
  // It does NOT beep on every keystroke.
  // --------------------------------------------------------

  const testerInputs = [
    "onceOps",
    "oncePeriod",
    "onceRetry",
    "onceValue",
    "onceScenario"
  ];


  for (
    const id of testerInputs
  ) {

    const input =
      document.getElementById(id);

    if (!input) {
      continue;
    }


    input.addEventListener(
      "change",
      () => {

        if (enabled) {
          telemetryPulse();
        }
      }
    );
  }

})();

// ==========================================================
// ONCE PRODUCT CONVERSION ANALYTICS
//
// Privacy-minimal aggregate events.
// Sends only:
//   event
//   source = "website"
//
// Analytics failure must never interfere with the product UI.
// ==========================================================

(() => {

  "use strict";


  const ENDPOINT =
    "https://playground.onceexec.com/analytics/event";


  const sent =
    new Set();


  function sendOnce(eventName) {

    if (
      sent.has(
        eventName
      )
    ) {
      return;
    }


    sent.add(
      eventName
    );


    fetch(
      ENDPOINT,
      {
        method:
          "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body:
          JSON.stringify({
            event:
              eventName,

            source:
              "website"
          }),

        keepalive:
          true
      }
    )
      .catch(
        () => {
          // Analytics is deliberately non-critical.
        }
      );
  }


  // --------------------------------------------------------
  // TESTER ENGAGEMENT
  // --------------------------------------------------------

  const testerIds =
    new Set([
      "onceOps",
      "oncePeriod",
      "onceRetry",
      "onceValue",
      "onceScenario"
    ]);


  function testerInteraction(event) {

    const target =
      event.target;

    if (
      !target ||
      !testerIds.has(
        target.id
      )
    ) {
      return;
    }


    sendOnce(
      "tester_used"
    );
  }


  document.addEventListener(
    "input",
    testerInteraction,
    true
  );

  document.addEventListener(
    "change",
    testerInteraction,
    true
  );


  // --------------------------------------------------------
  // CONVERSION INTENT
  // --------------------------------------------------------

  document.addEventListener(
    "click",
    (event) => {

      const target =
        event.target instanceof Element
          ? event.target
          : null;

      if (!target) {
        return;
      }


      // MCP command copied from the hero.

      const copyButton =
        target.closest(
          "[data-copy]"
        );

      if (
        copyButton &&
        copyButton.getAttribute(
          "data-copy"
        ) ===
          "npx -y @once-agent/mcp"
      ) {

        sendOnce(
          "mcp_copy_clicked"
        );
      }


      if (
        copyButton &&
        copyButton.getAttribute(
          "data-copy"
        ) ===
          "npm install @once-agent/sdk"
      ) {

        sendOnce(
          "sdk_copy_clicked"
        );
      }


      // Customer scale comparison executed.

      if (
        target.closest(
          "#onceScaleRun"
        )
      ) {

        sendOnce(
          "tester_run"
        );
      }


      const anchor =
        target.closest(
          "a[href]"
        );

      if (!anchor) {
        return;
      }


      // Hero / navigation intent to reach the tester.

      if (
        anchor.getAttribute(
          "href"
        ) ===
          "#tester"
      ) {

        sendOnce(
          "tester_cta_clicked"
        );

        return;
      }


      if (
        anchor.getAttribute(
          "href"
        ) ===
          "#developers" &&
        anchor.closest(
          ".once-scale-close-actions"
        )
      ) {

        sendOnce(
          "install_path_clicked"
        );

        return;
      }


      let url;

      try {

        url =
          new URL(
            anchor.href,
            window.location.href
          );

      }
      catch {
        return;
      }


      if (
        url.hostname ===
          "playground.onceexec.com"
      ) {

        sendOnce(
          "playground_clicked"
        );

        return;
      }


      if (
        url.hostname ===
          "www.npmjs.com" &&
        url.pathname.startsWith(
          "/package/@once-agent/sdk"
        )
      ) {

        sendOnce(
          "npm_clicked"
        );

        return;
      }


      if (
        url.hostname ===
          "www.npmjs.com" &&
        url.pathname.startsWith(
          "/package/@once-agent/mcp"
        )
      ) {

        sendOnce(
          "mcp_npm_clicked"
        );

        return;
      }


      if (
        url.hostname ===
          "github.com" &&
        url.pathname
          .replace(
            /\/+$/,
            ""
          )
          .toLowerCase() ===
            "/stringsofthemind-oss/once"
      ) {

        sendOnce(
          "github_clicked"
        );

        return;
      }


      if (
        url.hostname ===
          window.location.hostname &&
        url.pathname.endsWith(
          "/agent.md"
        )
      ) {

        sendOnce(
          "agent_guide_clicked"
        );
      }

    },
    true
  );

})();

// ONCE SCALE COMPARISON TESTER
import("./tester-v2.js?v=scale-1").catch((error) => console.error("Once tester v2 failed", error));

// ------------------------------------------------------------
// ONCE LIVE NETWORK COUNTER
// Read-only production telemetry.
// ------------------------------------------------------------

(() => {

  const valueEl =
    document.getElementById("once-network-value");

  const labelEl =
    document.getElementById("once-network-label");

  const statusEl =
    document.getElementById("once-network-status");

  const networkEl =
    document.getElementById("once-network");

  if (!valueEl || !labelEl || !statusEl || !networkEl) {
    return;
  }

  let previousValue = null;

  function renderCount(value) {

    const count = Number(value);

    if (!Number.isFinite(count) || count < 0) {
      throw new Error("Invalid protected_operations value");
    }

    const normalized = Math.floor(count);

    valueEl.textContent =
      normalized.toLocaleString();

    labelEl.textContent =
      normalized === 1
        ? "protected operation"
        : "protected operations";

    statusEl.textContent =
      "LIVE • PRODUCTION COUNTER";

    networkEl.classList.add("is-live");

    if (
      previousValue !== null &&
      normalized > previousValue
    ) {

      networkEl.classList.remove(
        "operation-confirmed"
      );

      void networkEl.offsetWidth;

      networkEl.classList.add(
        "operation-confirmed"
      );
    }

    previousValue = normalized;
  }

  async function refreshOnceNetwork() {


    try {

      const response = await fetch(
        "https://once-q18-cloud.pennywatch.workers.dev/v1/public/stats",
        {
          method: "GET",
          headers: {
            "Accept": "application/json"
          },
          cache: "no-store"
        }
      );

      if (!response.ok) {
        throw new Error(
          `Once stats returned ${response.status}`
        );
      }

      const data = await response.json();

      renderCount(
        data.protected_operations
      );

    } catch (error) {

      console.warn(
        "Once live network counter unavailable",
        error
      );

      if (previousValue === null) {

        valueEl.textContent = "—";

        labelEl.textContent =
          "protected operations";

        statusEl.textContent =
          "LIVE TELEMETRY UNAVAILABLE";

        networkEl.classList.remove(
          "is-live"
        );
      }
    }
  }

  refreshOnceNetwork();

  window.setInterval(
    refreshOnceNetwork,
    15000
  );

})();

/* ==========================================================
   ONCE / QUICK-JUMP RAIL
   Tracks the section currently occupying the reading zone.
   ========================================================== */

(() => {

  const links = Array.from(
    document.querySelectorAll(".once-jump-link[data-once-jump]")
  );

  if (!links.length) {
    return;
  }

  const targets = links
    .map((link) => {
      const id = link.dataset.onceJump;
      const section = document.getElementById(id);

      return section
        ? { id, link, section }
        : null;
    })
    .filter(Boolean);

  if (!targets.length) {
    return;
  }

  let activeId = null;

  function setActive(id) {

    if (id === activeId) {
      return;
    }

    activeId = id;

    targets.forEach(({ id: targetId, link }) => {

      const active = targetId === id;

      link.classList.toggle(
        "is-active",
        active
      );

      if (active) {
        link.setAttribute(
          "aria-current",
          "location"
        );
      } else {
        link.removeAttribute(
          "aria-current"
        );
      }
    });
  }

  function updateActiveSection() {

    const readingLine =
      window.innerHeight * 0.38;

    let current = targets[0];

    for (const target of targets) {

      const rect =
        target.section.getBoundingClientRect();

      if (rect.top <= readingLine) {
        current = target;
      } else {
        break;
      }
    }

    setActive(current.id);
  }

  links.forEach((link) => {

    link.addEventListener(
      "click",
      () => {

        const id =
          link.dataset.onceJump;

        setActive(id);
      }
    );
  });

  let ticking = false;

  function requestUpdate() {

    if (ticking) {
      return;
    }

    ticking = true;

    window.requestAnimationFrame(() => {
      updateActiveSection();
      ticking = false;
    });
  }

  window.addEventListener(
    "scroll",
    requestUpdate,
    { passive:true }
  );

  window.addEventListener(
    "resize",
    requestUpdate
  );

  updateActiveSection();

})();
