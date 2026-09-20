import { createHash } from "node:crypto";

import {
  appendBenchmarkObservation,
  type BenchmarkObservation
} from "./benchmark.js";

export interface TraceFetchOptions {
  tracePath?: string;
  resource?: string;
}

export interface TraceFetchResult {
  observation: BenchmarkObservation;
  status: number;
  ok: boolean;
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

export async function traceFetch(
  urlValue: string,
  options: TraceFetchOptions = {}
): Promise<TraceFetchResult> {
  const url = canonicalUrl(urlValue);
  const tracePath = options.tracePath ?? ".once/agent-trace.jsonl";
  const resource = options.resource ?? `url:${url}`;

  const startedAt = performance.now();
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow"
  });
  const body = Buffer.from(await response.arrayBuffer());
  const latencyMs = performance.now() - startedAt;

  const fingerprint = createHash("sha256")
    .update(body)
    .digest("hex");

  const observation: BenchmarkObservation = {
    timestamp: new Date().toISOString(),
    resource,
    fingerprint,
    latency_ms: latencyMs,
    response_bytes: body.byteLength,
    metadata: {
      collector: "once-trace-fetch-v1",
      url,
      status: response.status,
      ok: response.ok,
      etag: response.headers.get("etag"),
      last_modified: response.headers.get("last-modified"),
      content_type: response.headers.get("content-type")
    }
  };

  // Raw evidence only. Do not attach once_decision here.
  await appendBenchmarkObservation(tracePath, observation);

  return {
    observation,
    status: response.status,
    ok: response.ok
  };
}

export async function runTraceFetch(
  urlValue: string,
  options: TraceFetchOptions = {}
): Promise<TraceFetchResult> {
  const result = await traceFetch(urlValue, options);

  console.log("");
  console.log("Once Trace");
  console.log("----------");
  console.log(`Resource: ${result.observation.resource}`);
  console.log(`HTTP status: ${result.status}`);
  console.log(`Fingerprint: ${result.observation.fingerprint}`);
  console.log(`Latency: ${result.observation.latency_ms?.toFixed(1) ?? "n/a"} ms`);
  console.log(`Response bytes: ${result.observation.response_bytes ?? 0}`);
  console.log(`Trace: ${options.tracePath ?? ".once/agent-trace.jsonl"}`);
  console.log("Mode: raw ground truth (no Once decision recorded)");

  return result;
}
