(() => {
  "use strict";

  const section = document.getElementById("tester");

  if (!section || section.dataset.onceTesterV2 === "1") {
    return;
  }

  const content = section.querySelector(".scene-content");

  if (!content) {
    return;
  }

  section.dataset.onceTesterV2 = "1";

  const styleId = "once-tester-v2-styles";

  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      #tester .scene-content {
        width: min(1500px, calc(100% - 40px));
      }

      .once-scale-tester {
        display: grid;
        gap: 26px;
      }

      .once-scale-intro {
        display: grid;
        grid-template-columns: minmax(0, 1.25fr) minmax(260px, .75fr);
        gap: 26px;
        align-items: end;
      }

      .once-scale-intro h2 {
        margin-bottom: 14px;
      }

      .once-scale-intro p {
        max-width: 760px;
      }

      .once-scale-kicker {
        display: inline-flex;
        align-items: center;
        gap: 9px;
        margin-bottom: 14px;
        font: 700 11px/1.1 var(--mono, monospace);
        letter-spacing: .16em;
        text-transform: uppercase;
        color: rgba(255,255,255,.62);
      }

      .once-scale-kicker::before {
        content: "";
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: #8dff9f;
        box-shadow: 0 0 18px rgba(141,255,159,.7);
      }

      .once-scale-promise {
        border: 1px solid rgba(141,255,159,.28);
        background: linear-gradient(135deg, rgba(13,30,23,.86), rgba(6,12,10,.68));
        padding: 20px;
        min-height: 100%;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }

      .once-scale-promise small {
        font: 700 10px/1.2 var(--mono, monospace);
        letter-spacing: .16em;
        color: rgba(255,255,255,.46);
      }

      .once-scale-promise strong {
        margin-top: 10px;
        font-size: clamp(20px, 2.4vw, 34px);
        line-height: 1.06;
        color: #dfffe4;
      }

      .once-scale-shell {
        border: 1px solid rgba(255,255,255,.13);
        background: rgba(5,8,10,.84);
        box-shadow: 0 24px 80px rgba(0,0,0,.34);
        overflow: hidden;
      }

      .once-scale-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        padding: 16px 20px;
        border-bottom: 1px solid rgba(255,255,255,.09);
        background: rgba(255,255,255,.025);
      }

      .once-scale-toolbar strong {
        display: block;
        font-size: 15px;
        margin-top: 3px;
      }

      .once-scale-toolbar small,
      .once-scale-badge {
        font: 700 10px/1.1 var(--mono, monospace);
        letter-spacing: .14em;
        text-transform: uppercase;
        color: rgba(255,255,255,.46);
      }

      .once-scale-badge {
        border: 1px solid rgba(141,255,159,.28);
        color: #a8ffb6;
        padding: 8px 10px;
        white-space: nowrap;
      }

      .once-scale-controls {
        display: grid;
        grid-template-columns: 1.2fr .7fr .7fr .8fr;
        gap: 14px;
        padding: 20px;
      }

      .once-scale-field {
        display: grid;
        gap: 8px;
      }

      .once-scale-field > span {
        font: 700 10px/1.15 var(--mono, monospace);
        letter-spacing: .11em;
        text-transform: uppercase;
        color: rgba(255,255,255,.5);
      }

      .once-scale-input,
      .once-scale-select {
        width: 100%;
        min-height: 48px;
        border: 1px solid rgba(255,255,255,.13);
        background: rgba(0,0,0,.34);
        color: #fff;
        padding: 0 13px;
        font: 700 15px/1 var(--mono, monospace);
        outline: none;
        border-radius: 0;
      }

      .once-scale-input:focus,
      .once-scale-select:focus {
        border-color: rgba(141,255,159,.65);
        box-shadow: 0 0 0 1px rgba(141,255,159,.16);
      }

      .once-scale-input-wrap {
        position: relative;
      }

      .once-scale-input-wrap .once-scale-input {
        padding-right: 44px;
      }

      .once-scale-suffix {
        position: absolute;
        right: 13px;
        top: 50%;
        transform: translateY(-50%);
        font: 700 11px/1 var(--mono, monospace);
        color: rgba(255,255,255,.45);
        pointer-events: none;
      }

      .once-scale-presets {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
        padding: 0 20px 20px;
      }

      .once-scale-presets span {
        align-self: center;
        margin-right: 3px;
        font: 700 9px/1 var(--mono, monospace);
        letter-spacing: .12em;
        color: rgba(255,255,255,.35);
      }

      .once-scale-preset {
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.035);
        color: rgba(255,255,255,.76);
        padding: 8px 10px;
        cursor: pointer;
        font: 700 10px/1 var(--mono, monospace);
        letter-spacing: .06em;
      }

      .once-scale-preset:hover,
      .once-scale-preset.active {
        border-color: rgba(141,255,159,.58);
        color: #b8ffc3;
        background: rgba(141,255,159,.08);
      }

      .once-scale-runbar {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 18px;
        align-items: center;
        padding: 16px 20px;
        border-top: 1px solid rgba(255,255,255,.08);
        border-bottom: 1px solid rgba(255,255,255,.08);
        background: rgba(255,255,255,.018);
      }

      .once-scale-runbar p {
        margin: 0;
        font-size: 12px;
        color: rgba(255,255,255,.48);
      }

      .once-scale-run {
        min-height: 45px;
        border: 1px solid rgba(141,255,159,.56);
        background: #b7ffc2;
        color: #071009;
        padding: 0 18px;
        cursor: pointer;
        font: 900 11px/1 var(--mono, monospace);
        letter-spacing: .12em;
      }

      .once-scale-run:hover {
        filter: brightness(1.06);
      }

      .once-scale-comparison {
        display: grid;
        grid-template-columns: 1fr 1fr;
      }

      .once-scale-side {
        position: relative;
        padding: 24px 22px 22px;
        min-width: 0;
      }

      .once-scale-side + .once-scale-side {
        border-left: 1px solid rgba(255,255,255,.1);
      }

      .once-scale-side.without {
        background: linear-gradient(180deg, rgba(65,13,19,.15), rgba(7,8,10,0));
      }

      .once-scale-side.with {
        background: linear-gradient(180deg, rgba(20,70,39,.18), rgba(7,8,10,0));
      }

      .once-scale-side-head {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        align-items: flex-start;
        margin-bottom: 22px;
      }

      .once-scale-side-head small {
        display: block;
        font: 800 10px/1 var(--mono, monospace);
        letter-spacing: .15em;
        color: rgba(255,255,255,.42);
        margin-bottom: 7px;
      }

      .once-scale-side-head strong {
        font-size: clamp(23px, 3vw, 40px);
        line-height: 1;
      }

      .once-scale-side.without .once-scale-side-head strong {
        color: #ff9d9d;
      }

      .once-scale-side.with .once-scale-side-head strong {
        color: #adffba;
      }

      .once-scale-state {
        font: 800 9px/1 var(--mono, monospace);
        letter-spacing: .12em;
        padding: 7px 9px;
        border: 1px solid rgba(255,255,255,.12);
        color: rgba(255,255,255,.52);
        white-space: nowrap;
      }

      .once-scale-side.with .once-scale-state {
        border-color: rgba(141,255,159,.34);
        color: #a8ffb6;
      }

      .once-scale-metrics {
        display: grid;
        grid-template-columns: repeat(2, minmax(0,1fr));
        gap: 10px;
      }

      .once-scale-metric {
        min-height: 112px;
        border: 1px solid rgba(255,255,255,.09);
        background: rgba(0,0,0,.25);
        padding: 13px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }

      .once-scale-metric small {
        font: 700 9px/1.25 var(--mono, monospace);
        letter-spacing: .09em;
        color: rgba(255,255,255,.4);
      }

      .once-scale-metric strong {
        font: 800 clamp(22px, 2.7vw, 38px)/1 var(--mono, monospace);
        letter-spacing: -.04em;
        overflow-wrap: anywhere;
      }

      .once-scale-metric span {
        font-size: 10px;
        color: rgba(255,255,255,.35);
      }

      .once-scale-danger {
        color: #ff9a9a;
      }

      .once-scale-safe {
        color: #9dffad;
      }

      .once-scale-verdict {
        margin-top: 12px;
        border: 1px solid rgba(255,255,255,.09);
        padding: 14px;
        display: grid;
        gap: 5px;
      }

      .once-scale-side.without .once-scale-verdict {
        border-color: rgba(255,116,116,.2);
        background: rgba(70,10,15,.11);
      }

      .once-scale-side.with .once-scale-verdict {
        border-color: rgba(141,255,159,.24);
        background: rgba(25,75,39,.12);
      }

      .once-scale-verdict small {
        font: 700 9px/1 var(--mono, monospace);
        letter-spacing: .12em;
        color: rgba(255,255,255,.38);
      }

      .once-scale-verdict strong {
        font-size: 15px;
      }

      .once-scale-impact {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 18px;
        align-items: center;
        padding: 22px;
        border-top: 1px solid rgba(255,255,255,.1);
        background: linear-gradient(90deg, rgba(141,255,159,.08), rgba(255,255,255,.015));
      }

      .once-scale-impact small {
        display: block;
        margin-bottom: 8px;
        font: 800 9px/1 var(--mono, monospace);
        letter-spacing: .14em;
        color: rgba(255,255,255,.4);
      }

      .once-scale-impact strong {
        display: block;
        font-size: clamp(23px, 3.2vw, 46px);
        line-height: 1.03;
        color: #c7ffcf;
      }

      .once-scale-impact span {
        display: block;
        max-width: 700px;
        margin-top: 8px;
        font-size: 12px;
        color: rgba(255,255,255,.48);
      }

      .once-scale-proof-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 0 15px;
        border: 1px solid rgba(255,255,255,.14);
        color: #fff;
        text-decoration: none;
        font: 800 10px/1 var(--mono, monospace);
        letter-spacing: .1em;
        white-space: nowrap;
      }

      .once-scale-proof-link:hover {
        border-color: rgba(141,255,159,.5);
        color: #b8ffc3;
      }

      .once-scale-footnotes {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-top: 12px;
      }

      .once-scale-note {
        border: 1px solid rgba(255,255,255,.08);
        background: rgba(0,0,0,.18);
        padding: 13px 14px;
        color: rgba(255,255,255,.43);
        font-size: 11px;
        line-height: 1.55;
      }

      .once-scale-note b {
        color: rgba(255,255,255,.72);
      }

      .once-scale-flash {
        animation: onceScaleFlash .55s ease;
      }

      @keyframes onceScaleFlash {
        0% { transform: translateY(2px); opacity: .65; }
        100% { transform: translateY(0); opacity: 1; }
      }

      @media (max-width: 1000px) {
        .once-scale-intro,
        .once-scale-controls {
          grid-template-columns: 1fr 1fr;
        }
      }

      @media (max-width: 760px) {
        #tester .scene-content {
          width: min(100% - 22px, 1500px);
        }

        .once-scale-intro,
        .once-scale-controls,
        .once-scale-comparison,
        .once-scale-impact,
        .once-scale-footnotes,
        .once-scale-runbar {
          grid-template-columns: 1fr;
        }

        .once-scale-side + .once-scale-side {
          border-left: 0;
          border-top: 1px solid rgba(255,255,255,.1);
        }

        .once-scale-metrics {
          grid-template-columns: 1fr 1fr;
        }

        .once-scale-proof-link,
        .once-scale-run {
          width: 100%;
        }
      }

      @media (max-width: 470px) {
        .once-scale-controls,
        .once-scale-metrics {
          grid-template-columns: 1fr;
        }
      }
    `;

    document.head.appendChild(style);
  }

  content.innerHTML = `
    <div class="once-scale-tester">

      <div class="once-scale-intro reveal visible">
        <div>
          <span class="once-scale-kicker">05 · TESTER / SCALE COMPARISON</span>
          <h2>
            Put your own traffic through the model.<br>
            See the retry problem at your scale.
          </h2>
          <p>
            Feed the same consequential traffic into both sides. The left models blind retry execution.
            The right models Once on the confirmed replay path. Use your own call volume — from one action to ten billion.
          </p>
        </div>

        <div class="once-scale-promise">
          <small>THE POINT</small>
          <strong>Once doesn't stop your agents retrying. It makes retries safe.</strong>
        </div>
      </div>

      <div class="once-scale-shell reveal visible">

        <div class="once-scale-toolbar">
          <div>
            <small>ONCE / CUSTOMER SCALE TESTER</small>
            <strong>Without Once vs With Once</strong>
          </div>
          <span class="once-scale-badge">SCALE SIMULATION</span>
        </div>

        <div class="once-scale-controls">

          <label class="once-scale-field">
            <span>CONSEQUENTIAL CALLS</span>
            <input
              class="once-scale-input"
              id="onceOps"
              type="number"
              min="1"
              max="10000000000"
              step="1000"
              value="10000000"
              inputmode="numeric"
            >
          </label>

          <label class="once-scale-field">
            <span>PERIOD</span>
            <select class="once-scale-select" id="oncePeriod">
              <option value="month" selected>PER MONTH</option>
              <option value="day">PER DAY</option>
            </select>
          </label>

          <label class="once-scale-field">
            <span>RETRY / DUPLICATE RATE</span>
            <div class="once-scale-input-wrap">
              <input
                class="once-scale-input"
                id="onceRetry"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value="0.10"
                inputmode="decimal"
              >
              <b class="once-scale-suffix">%</b>
            </div>
          </label>

          <label class="once-scale-field">
            <span>AVG VALUE / ACTION</span>
            <div class="once-scale-input-wrap">
              <input
                class="once-scale-input"
                id="onceValue"
                type="number"
                min="0"
                max="1000000000"
                step="1"
                value="75"
                inputmode="decimal"
              >
              <b class="once-scale-suffix">£</b>
            </div>
          </label>

          <label class="once-scale-field">
            <span>ACTION TYPE</span>
            <select class="once-scale-select" id="onceScenario">
              <option value="payment" selected>PAYMENT</option>
              <option value="booking">BOOKING</option>
              <option value="order">ORDER</option>
              <option value="email">EMAIL</option>
              <option value="provision">PROVISION ACCOUNT</option>
              <option value="deploy">PRODUCTION DEPLOYMENT</option>
            </select>
          </label>

        </div>

        <div class="once-scale-presets" aria-label="Traffic presets">
          <span>TRAFFIC PRESETS</span>
          <button class="once-scale-preset" type="button" data-once-scale="10000">10K</button>
          <button class="once-scale-preset" type="button" data-once-scale="100000">100K</button>
          <button class="once-scale-preset" type="button" data-once-scale="1000000">1M</button>
          <button class="once-scale-preset active" type="button" data-once-scale="10000000">10M</button>
          <button class="once-scale-preset" type="button" data-once-scale="100000000">100M</button>
          <button class="once-scale-preset" type="button" data-once-scale="1000000000">1B</button>
          <button class="once-scale-preset" type="button" data-once-scale="10000000000">10B</button>
        </div>

        <div class="once-scale-presets" aria-label="Retry rate presets">
          <span>RETRY RATE</span>
          <button class="once-scale-preset" type="button" data-once-retry="0.01">0.01%</button>
          <button class="once-scale-preset active" type="button" data-once-retry="0.10">0.10%</button>
          <button class="once-scale-preset" type="button" data-once-retry="0.50">0.50%</button>
          <button class="once-scale-preset" type="button" data-once-retry="1">1.00%</button>
          <button class="once-scale-preset" type="button" data-once-retry="5">5.00%</button>
        </div>

        <div class="once-scale-runbar">
          <p>
            This is a client-side scale model. Enter 10B and the browser performs arithmetic — it does not send 10B requests.
            The live proof environment is linked below.
          </p>
          <button class="once-scale-run button-primary" id="onceScaleRun" type="button">RUN COMPARISON</button>
        </div>

        <div class="once-scale-comparison" id="onceScaleComparison">

          <section class="once-scale-side without">
            <div class="once-scale-side-head">
              <div>
                <small>WITHOUT ONCE</small>
                <strong>Blind retry</strong>
              </div>
              <span class="once-scale-state">RE-EXECUTE</span>
            </div>

            <div class="once-scale-metrics">
              <div class="once-scale-metric">
                <small>INCOMING ATTEMPTS / <span data-once-period-label>MONTH</span></small>
                <strong id="onceWithoutAttempts">10,010,000</strong>
                <span>original calls + retries</span>
              </div>

              <div class="once-scale-metric">
                <small>MODELED PROVIDER EXECUTIONS</small>
                <strong id="onceWithoutExec">10,010,000</strong>
                <span>if every retry is executed again</span>
              </div>

              <div class="once-scale-metric">
                <small>RETRY EXECUTION OPPORTUNITIES</small>
                <strong class="once-scale-danger" id="onceWithoutDupes">10,000</strong>
                <span>same logical work arrives again</span>
              </div>

              <div class="once-scale-metric">
                <small>VALUE THROUGH RETRY AMBIGUITY</small>
                <strong class="once-scale-danger" id="onceWithoutValue">£750,000</strong>
                <span>not a savings claim</span>
              </div>
            </div>

            <div class="once-scale-verdict">
              <small>DECISION</small>
              <strong>Retry the call and hope the first attempt did not already take effect.</strong>
            </div>
          </section>

          <section class="once-scale-side with">
            <div class="once-scale-side-head">
              <div>
                <small>WITH ONCE</small>
                <strong>Safe retry path</strong>
              </div>
              <span class="once-scale-state">REPLAY / BLOCK</span>
            </div>

            <div class="once-scale-metrics">
              <div class="once-scale-metric">
                <small>INCOMING ATTEMPTS / <span data-once-period-label>MONTH</span></small>
                <strong id="onceWithAttempts">10,010,000</strong>
                <span>same traffic, same retry pressure</span>
              </div>

              <div class="once-scale-metric">
                <small>MODELED PROVIDER EXECUTIONS</small>
                <strong class="once-scale-safe" id="onceWithExec">10,000,000</strong>
                <span>confirmed replay path</span>
              </div>

              <div class="once-scale-metric">
                <small>RETRIES INTERCEPTED</small>
                <strong class="once-scale-safe" id="onceWithReplays">10,000</strong>
                <span>replay instead of execute again</span>
              </div>

              <div class="once-scale-metric">
                <small>BLIND RE-EXECUTIONS</small>
                <strong class="once-scale-safe" id="onceWithBlind">0</strong>
                <span>on confirmed replay path</span>
              </div>
            </div>

            <div class="once-scale-verdict">
              <small>DECISION</small>
              <strong>CONFIRMED → replay. ABSENT → execute. UNKNOWN → block rather than guess.</strong>
            </div>
          </section>

        </div>

        <div class="once-scale-impact" id="onceScaleImpact">
          <div>
            <small>AT YOUR SCALE</small>
            <strong id="onceImpactHeadline">10,000 modeled blind retry executions removed.</strong>
            <span id="onceImpactDetail">
              £750,000 of payment value passes through those retry events. This is exposure context, not a claim that every retry becomes a duplicate charge.
            </span>
          </div>

          <a
            class="once-scale-proof-link"
            href="https://once-sandbox-playground.pennywatch.workers.dev/"
            target="_blank"
            rel="noopener"
          >
            OPEN LIVE PROOF ↗
          </a>
        </div>

      </div>

      <div class="once-scale-footnotes">
        <div class="once-scale-note">
          <b>What the left side means:</b> it deliberately models the dangerous baseline where a retry is blindly sent to a non-idempotent provider and executes again. Real providers may have their own protections.
        </div>
        <div class="once-scale-note">
          <b>What the right side means:</b> the execution count reflects Once's confirmed/replay path. Once does not claim generic exactly-once execution; uncertain outcomes are designed to fail closed rather than be blindly retried.
        </div>
      </div>

    </div>
  `;

  const ops = document.getElementById("onceOps");
  const period = document.getElementById("oncePeriod");
  const retry = document.getElementById("onceRetry");
  const value = document.getElementById("onceValue");
  const scenario = document.getElementById("onceScenario");
  const run = document.getElementById("onceScaleRun");
  const comparison = document.getElementById("onceScaleComparison");
  const impact = document.getElementById("onceScaleImpact");

  const withoutAttempts = document.getElementById("onceWithoutAttempts");
  const withoutExec = document.getElementById("onceWithoutExec");
  const withoutDupes = document.getElementById("onceWithoutDupes");
  const withoutValue = document.getElementById("onceWithoutValue");
  const withAttempts = document.getElementById("onceWithAttempts");
  const withExec = document.getElementById("onceWithExec");
  const withReplays = document.getElementById("onceWithReplays");
  const withBlind = document.getElementById("onceWithBlind");
  const impactHeadline = document.getElementById("onceImpactHeadline");
  const impactDetail = document.getElementById("onceImpactDetail");

  const numberFormat = new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: 0
  });

  const currencyFormat = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0
  });

  const scenarioNames = {
    payment: "payment",
    booking: "booking",
    order: "order",
    email: "email",
    provision: "account provisioning action",
    deploy: "production deployment"
  };

  const clamp = (input, min, max, fallback) => {
    const parsed = Number(input);

    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
  };

  const render = (animate = false) => {
    const logicalCalls = clamp(ops.value, 1, 10_000_000_000, 10_000_000);
    const retryRate = clamp(retry.value, 0, 100, 0.1);
    const averageValue = clamp(value.value, 0, 1_000_000_000, 0);
    const retryEvents = logicalCalls * (retryRate / 100);
    const incomingAttempts = logicalCalls + retryEvents;
    const blindExecutions = incomingAttempts;
    const onceExecutions = logicalCalls;
    const ambiguousValue = retryEvents * averageValue;
    const periodLabel = period.value === "day" ? "DAY" : "MONTH";
    const action = scenarioNames[scenario.value] || "action";

    document.querySelectorAll("[data-once-period-label]").forEach((node) => {
      node.textContent = periodLabel;
    });

    withoutAttempts.textContent = numberFormat.format(Math.round(incomingAttempts));
    withoutExec.textContent = numberFormat.format(Math.round(blindExecutions));
    withoutDupes.textContent = numberFormat.format(Math.round(retryEvents));
    withoutValue.textContent = currencyFormat.format(Math.round(ambiguousValue));

    withAttempts.textContent = numberFormat.format(Math.round(incomingAttempts));
    withExec.textContent = numberFormat.format(Math.round(onceExecutions));
    withReplays.textContent = numberFormat.format(Math.round(retryEvents));
    withBlind.textContent = "0";

    impactHeadline.textContent =
      `${numberFormat.format(Math.round(retryEvents))} modeled blind retry executions removed.`;

    if (averageValue > 0) {
      impactDetail.textContent =
        `${currencyFormat.format(Math.round(ambiguousValue))} of ${action} value passes through those retry events. ` +
        `This is exposure context, not a claim that every retry becomes a duplicate side effect.`;
    } else {
      impactDetail.textContent =
        `${numberFormat.format(Math.round(retryEvents))} ${action} retry events are routed away from blind re-execution on the confirmed replay path.`;
    }

    document.querySelectorAll("[data-once-scale]").forEach((button) => {
      button.classList.toggle(
        "active",
        Number(button.dataset.onceScale) === logicalCalls
      );
    });

    document.querySelectorAll("[data-once-retry]").forEach((button) => {
      button.classList.toggle(
        "active",
        Number(button.dataset.onceRetry) === retryRate
      );
    });

    if (animate) {
      comparison.classList.remove("once-scale-flash");
      impact.classList.remove("once-scale-flash");

      void comparison.offsetWidth;

      comparison.classList.add("once-scale-flash");
      impact.classList.add("once-scale-flash");
    }
  };

  for (const input of [ops, period, retry, value, scenario]) {
    input.addEventListener("input", () => render(false));
    input.addEventListener("change", () => render(true));
  }

  document.querySelectorAll("[data-once-scale]").forEach((button) => {
    button.addEventListener("click", () => {
      ops.value = button.dataset.onceScale;
      render(true);
    });
  });

  document.querySelectorAll("[data-once-retry]").forEach((button) => {
    button.addEventListener("click", () => {
      retry.value = button.dataset.onceRetry;
      render(true);
    });
  });

  run.addEventListener("click", () => {
    render(true);
  });

  render(false);
})();
