import { performance } from "node:perf_hooks";

const BASE_URL =
  "https://api.onceexec.com";

const SAMPLES = 20;
const PAUSE_MS = 125;

const apiKey =
  process.env.ONCE_API_KEY;

if (!apiKey) {
  throw new Error(
    "ONCE_API_KEY missing"
  );
}

const sleep = ms =>
  new Promise(resolve =>
    setTimeout(resolve, ms)
  );

function percentile(values, p) {
  const sorted =
    [...values].sort(
      (a, b) => a - b
    );

  return sorted[
    Math.min(
      sorted.length - 1,
      Math.max(
        0,
        Math.ceil(
          p / 100 *
          sorted.length
        ) - 1
      )
    )
  ];
}

function stats(values) {
  const clean =
    values.filter(Number.isFinite);

  return {
    n: clean.length,

    mean:
      clean.reduce(
        (sum, n) => sum + n,
        0
      ) / clean.length,

    p50:
      percentile(clean, 50),

    p95:
      percentile(clean, 95),

    p99:
      percentile(clean, 99),

    min:
      Math.min(...clean),

    max:
      Math.max(...clean),
  };
}

function show(name, values) {
  const s = stats(values);

  console.log(`\n${name}`);
  console.log("-".repeat(name.length));
  console.log(`n    : ${s.n}`);
  console.log(`mean : ${s.mean.toFixed(3)} ms`);
  console.log(`p50  : ${s.p50.toFixed(3)} ms`);
  console.log(`p95  : ${s.p95.toFixed(3)} ms`);
  console.log(`p99  : ${s.p99.toFixed(3)} ms`);
  console.log(`min  : ${s.min.toFixed(3)} ms`);
  console.log(`max  : ${s.max.toFixed(3)} ms`);
}

function parseServerTiming(header) {
  if (!header) {
    throw new Error(
      "Server-Timing header missing"
    );
  }

  const result = {};

  for (
    const raw of
    header.split(",")
  ) {
    const parts =
      raw.trim().split(";");

    const name =
      parts.shift()?.trim();

    if (!name) {
      continue;
    }

    for (const part of parts) {
      const item = part.trim();

      if (
        item.startsWith("dur=")
      ) {
        const value =
          Number(item.slice(4));

        if (
          Number.isFinite(value)
        ) {
          result[name] = value;
        }
      }
    }
  }

  return result;
}

function requireMetrics(
  timing,
  names,
  context
) {
  for (const name of names) {
    if (
      !Number.isFinite(
        timing[name]
      )
    ) {
      throw new Error(
        `${context}: missing ${name}`
      );
    }
  }
}

async function execute(operationId) {
  const body = {
    operation_id: operationId,

    provider:
      "blind_test",

    action: {
      benchmark:
        "production-server-timing-v1",
    },
  };

  const started =
    performance.now();

  const response =
    await fetch(
      `${BASE_URL}/v1/execute`,
      {
        method: "POST",

        headers: {
          authorization:
            `Bearer ${apiKey}`,

          "content-type":
            "application/json",

          "x-once-benchmark":
            "server-timing-v1",
        },

        body:
          JSON.stringify(body),
      }
    );

  const text =
    await response.text();

  const elapsed =
    performance.now() -
    started;

  let json;

  try {
    json =
      JSON.parse(text);
  } catch {
    throw new Error(
      `Non-JSON HTTP ${response.status}: ${text}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${text}`
    );
  }

  return {
    elapsed,
    json,

    timing:
      parseServerTiming(
        response.headers.get(
          "server-timing"
        )
      ),
  };
}

const common = [
  "api_maintenance",
  "api_auth",
  "api_entitlement",
  "api_rate_limit",
  "api_parse",
  "api_semantic_lookup",
  "api_metering",
  "api_semantic_commit",
  "api_core_roundtrip",
  "api_response",
  "api_total",

  "core_maintenance",
  "core_preflight",
  "core_provider_truth",
  "core_total",
];

const freshOnly = [
  "core_claim",
  "core_claim_sync",
  "core_provider_execute",
  "core_confirm",
];

const replayOnly = [
  "core_replay_finalize",
];

console.log(
  "\n=== PHASE 6 CONNECTION WARMUP ==="
);

for (
  let i = 1;
  i <= 3;
  i += 1
) {
  const started =
    performance.now();

  const response =
    await fetch(`${BASE_URL}/`);

  await response.arrayBuffer();

  console.log(
    `warmup ${i}: ${
      (
        performance.now() -
        started
      ).toFixed(3)
    } ms`
  );

  await sleep(100);
}

console.log(
  `\n=== ${SAMPLES} PAIRED PHASE 6 OPERATIONS ===`
);

const run =
  `${Date.now()}-${
    Math.random()
      .toString(16)
      .slice(2, 10)
  }`;

const rows = [];

for (
  let i = 1;
  i <= SAMPLES;
  i += 1
) {
  const operationId =
    `latency-server-${
      run
    }-${
      String(i).padStart(2, "0")
    }`;

  const fresh =
    await execute(operationId);

  if (
    fresh.json.result !==
      "executed" ||
    fresh.json.state !==
      "CONFIRMED" ||
    fresh.json.side_effects !== 1
  ) {
    throw new Error(
      `Fresh invariant failed sample ${i}: ` +
      JSON.stringify(fresh.json)
    );
  }

  requireMetrics(
    fresh.timing,
    [
      ...common,
      ...freshOnly,
    ],
    `fresh ${i}`
  );

  await sleep(PAUSE_MS);

  const replay =
    await execute(operationId);

  if (
    replay.json.result !==
      "already_executed" ||
    replay.json.state !==
      "CONFIRMED" ||
    replay.json.side_effects !== 1
  ) {
    throw new Error(
      `Replay invariant failed sample ${i}: ` +
      JSON.stringify(replay.json)
    );
  }

  requireMetrics(
    replay.timing,
    [
      ...common,
      ...replayOnly,
    ],
    `replay ${i}`
  );

  rows.push({
    sample: i,
    fresh,
    replay,
  });

  console.log(
    `${String(i).padStart(2, "0")} | ` +
    `fresh=${fresh.elapsed.toFixed(3)} ` +
    `truth=${fresh.timing.core_provider_truth.toFixed(3)} ` +
    `sync=${fresh.timing.core_claim_sync.toFixed(3)} ` +
    `execute=${fresh.timing.core_provider_execute.toFixed(3)} | ` +
    `replay=${replay.elapsed.toFixed(3)} ` +
    `truth=${replay.timing.core_provider_truth.toFixed(3)}`
  );

  await sleep(PAUSE_MS);
}

if (
  !rows.every(
    row =>
      row.replay.json
        .side_effects === 1
  )
) {
  throw new Error(
    "SAFETY FAILURE: duplicate effect detected"
  );
}

console.log(
  "\n============================================"
);

console.log(
  "PHASE 6 SERVER-SIDE LATENCY DECOMPOSITION"
);

console.log(
  "============================================"
);

show(
  "Fresh client end-to-end",
  rows.map(
    r => r.fresh.elapsed
  )
);

show(
  "Replay client end-to-end",
  rows.map(
    r => r.replay.elapsed
  )
);

show(
  "Fresh API total",
  rows.map(
    r => r.fresh.timing.api_total
  )
);

show(
  "Replay API total",
  rows.map(
    r => r.replay.timing.api_total
  )
);

show(
  "Fresh core total",
  rows.map(
    r => r.fresh.timing.core_total
  )
);

show(
  "Replay core total",
  rows.map(
    r => r.replay.timing.core_total
  )
);

show(
  "Fresh provider truth HTTPS",
  rows.map(
    r =>
      r.fresh.timing
        .core_provider_truth
  )
);

show(
  "Replay provider truth HTTPS",
  rows.map(
    r =>
      r.replay.timing
        .core_provider_truth
  )
);

show(
  "Fresh durable claim sync",
  rows.map(
    r =>
      r.fresh.timing
        .core_claim_sync
  )
);

show(
  "Fresh provider execute HTTPS",
  rows.map(
    r =>
      r.fresh.timing
        .core_provider_execute
  )
);

show(
  "Fresh API excluding core",
  rows.map(
    r =>
      r.fresh.timing.api_total -
      r.fresh.timing.api_core_roundtrip
  )
);

show(
  "Replay API excluding core",
  rows.map(
    r =>
      r.replay.timing.api_total -
      r.replay.timing.api_core_roundtrip
  )
);

show(
  "Fresh client/edge remainder",
  rows.map(
    r =>
      r.fresh.elapsed -
      r.fresh.timing.api_total
  )
);

show(
  "Replay client/edge remainder",
  rows.map(
    r =>
      r.replay.elapsed -
      r.replay.timing.api_total
  )
);

const freshMetrics = [
  "api_maintenance",
  "api_auth",
  "api_entitlement",
  "api_rate_limit",
  "api_parse",
  "api_semantic_lookup",
  "api_metering",
  "api_semantic_commit",
  "api_response",
  "core_maintenance",
  "core_preflight",
  "core_provider_truth",
  "core_claim",
  "core_claim_sync",
  "core_provider_execute",
  "core_confirm",
];

const replayMetrics = [
  "api_maintenance",
  "api_auth",
  "api_entitlement",
  "api_rate_limit",
  "api_parse",
  "api_semantic_lookup",
  "api_metering",
  "api_semantic_commit",
  "api_response",
  "core_maintenance",
  "core_preflight",
  "core_provider_truth",
  "core_replay_finalize",
];

function mean(side, metric) {
  return stats(
    rows.map(
      row =>
        row[side]
          .timing[metric]
    )
  ).mean;
}

console.log(
  "\nFresh mean stage breakdown"
);

console.table(
  freshMetrics.map(
    metric => ({
      metric,

      mean_ms:
        Number(
          mean(
            "fresh",
            metric
          ).toFixed(3)
        ),
    })
  )
);

console.log(
  "\nReplay mean stage breakdown"
);

console.table(
  replayMetrics.map(
    metric => ({
      metric,

      mean_ms:
        Number(
          mean(
            "replay",
            metric
          ).toFixed(3)
        ),
    })
  )
);

console.log(
  "\nSafety evidence"
);

console.log(
  "---------------"
);

console.log(
  `HTTP requests      : ${SAMPLES * 2}`
);

console.log(
  `logical operations : ${SAMPLES}`
);

console.log(
  `expected effects   : ${SAMPLES}`
);

console.log(
  `all replay effects=1 : ${
    rows.every(
      row =>
        row.replay.json
          .side_effects === 1
    )
  }`
);

console.log(
  "\nPHASE 6 SERVER-TIMING BENCHMARK PASSED"
);