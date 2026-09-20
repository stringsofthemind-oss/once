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
// ONCE TESTER — INTERACTIVE EXPOSURE MODEL
// ==========================================================

(() => {

  const ops =
    document.getElementById("onceOps");

  const retry =
    document.getElementById("onceRetry");

  const coverage =
    document.getElementById("onceCoverage");

  const exposed =
    document.getElementById("onceExposed");

  const protectedOutput =
    document.getElementById("onceProtected");

  const residual =
    document.getElementById("onceResidual");

  const coverageReadout =
    document.getElementById("onceCoverageReadout");

  const coverageMeter =
    document.getElementById("onceCoverageMeter");


  if (
    !ops ||
    !retry ||
    !coverage ||
    !exposed ||
    !protectedOutput ||
    !residual ||
    !coverageReadout ||
    !coverageMeter
  ) {
    return;
  }


  const clamp =
    (value, minimum, maximum) =>
      Math.min(
        maximum,
        Math.max(
          minimum,
          value
        )
      );


  const number =
    (element, fallback) => {

      const value =
        Number(
          element.value
        );

      return Number.isFinite(value)
        ? value
        : fallback;
    };


  const integerFormatter =
    new Intl.NumberFormat(
      "en-GB",
      {
        maximumFractionDigits: 0
      }
    );


  function calculate() {

    const monthlyOps =
      clamp(
        number(ops, 0),
        0,
        1_000_000_000
      );

    const retryPercent =
      clamp(
        number(retry, 0),
        0,
        100
      );

    const coveragePercent =
      clamp(
        number(coverage, 0),
        0,
        100
      );


    const exposedCount =
      monthlyOps *
      (
        retryPercent /
        100
      );


    const protectedCount =
      exposedCount *
      (
        coveragePercent /
        100
      );


    const residualCount =
      exposedCount -
      protectedCount;


    exposed.textContent =
      integerFormatter.format(
        Math.round(
          exposedCount
        )
      );


    protectedOutput.textContent =
      integerFormatter.format(
        Math.round(
          protectedCount
        )
      );


    residual.textContent =
      integerFormatter.format(
        Math.round(
          residualCount
        )
      );


    coverageReadout.textContent =
      coveragePercent.toFixed(
        coveragePercent % 1 === 0
          ? 0
          : 1
      ) + "%";


    coverageMeter.style.width =
      coveragePercent + "%";
  }


  for (
    const input of
    [ops, retry, coverage]
  ) {

    input.addEventListener(
      "input",
      calculate
    );

    input.addEventListener(
      "change",
      calculate
    );
  }


  calculate();

})();


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
    "onceRetry",
    "onceCoverage"
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
    "https://once-sandbox-playground.pennywatch.workers.dev/analytics/event";


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
      "onceRetry",
      "onceCoverage"
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
  // OUTBOUND CONVERSION INTENT
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


      const anchor =
        target.closest(
          "a[href]"
        );

      if (!anchor) {
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
          "once-sandbox-playground.pennywatch.workers.dev"
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
      }

    },
    true
  );

})();

// ONCE SCALE COMPARISON TESTER
import("./tester-v2.js?v=scale-1").catch((error) => console.error("Once tester v2 failed", error));
