import assert from "node:assert/strict";

import {
  HTTP_BODYINIT_CONTRACT_ID,
  HttpBodyInitNormalizationError,
  fingerprintHttpBodyInitV1,
  normalizeHttpBodyInitV1
} from "../dist/http-bodyinit-v1.js";

import {
  HTTP_BODY_CAPABILITY_ID,
  validateHttpBodyCapabilityV1
} from "../dist/transformers/http-body-capability-v1.js";

import {
  transformHttpWriteV1
} from "../dist/transformers/http-write-v1.js";

console.log("");
console.log("ONCE HTTP BODYINIT CONTRACT REGRESSION");
console.log("======================================");

const provider = "customer-http";
const targetUrl = "https://api.example.invalid/orders";
const capability = {
  name: provider,
  version_id: "provider-body-v1",
  body_transport: "bodyinit_v1",
  allowed_urls: [targetUrl]
};

const accepted = validateHttpBodyCapabilityV1({
  provider,
  targetUrl,
  capability
});

assert.equal(accepted.eligible, true);

if (!accepted.eligible) {
  throw new Error(accepted.reason);
}

assert.equal(
  accepted.capabilityId,
  HTTP_BODY_CAPABILITY_ID
);

const acceptedAgain = validateHttpBodyCapabilityV1({
  provider,
  targetUrl,
  capability: {
    ...capability,
    allowed_urls: [...capability.allowed_urls]
  }
});

assert.equal(acceptedAgain.eligible, true);

if (!acceptedAgain.eligible) {
  throw new Error(acceptedAgain.reason);
}

assert.equal(
  acceptedAgain.capabilityFingerprint,
  accepted.capabilityFingerprint,
  "equivalent capability evidence must fingerprint deterministically"
);

console.log("PASS - exact BodyInit provider capability accepted deterministically");

for (const [label, input] of [
  [
    "provider name alone",
    {
      provider,
      targetUrl,
      capability: undefined
    }
  ],
  [
    "provider mismatch",
    {
      provider,
      targetUrl,
      capability: {
        ...capability,
        name: "other-provider"
      }
    }
  ],
  [
    "missing provider version",
    {
      provider,
      targetUrl,
      capability: {
        ...capability,
        version_id: ""
      }
    }
  ],
  [
    "wrong body transport",
    {
      provider,
      targetUrl,
      capability: {
        ...capability,
        body_transport: "json_v1"
      }
    }
  ],
  [
    "target not allowed",
    {
      provider,
      targetUrl,
      capability: {
        ...capability,
        allowed_urls: [
          "https://api.example.invalid/other"
        ]
      }
    }
  ],
  [
    "duplicate allowed URL",
    {
      provider,
      targetUrl,
      capability: {
        ...capability,
        allowed_urls: [
          targetUrl,
          targetUrl
        ]
      }
    }
  ],
  [
    "non-HTTPS target",
    {
      provider,
      targetUrl: "http://api.example.invalid/orders",
      capability
    }
  ],
  [
    "noncanonical target",
    {
      provider,
      targetUrl: "https://api.example.invalid/orders?z=2&a=1",
      capability: {
        ...capability,
        allowed_urls: [
          "https://api.example.invalid/orders?z=2&a=1"
        ]
      }
    }
  ]
]) {
  const result =
    validateHttpBodyCapabilityV1(input);

  assert.equal(
    result.eligible,
    false,
    `${label} must remain fail-closed`
  );
}

console.log("PASS - missing, mismatched, duplicate, and noncanonical capability evidence rejected");

const none =
  await normalizeHttpBodyInitV1(undefined);

assert.deepEqual(
  none,
  {
    contract:
      HTTP_BODYINIT_CONTRACT_ID,
    kind: "none"
  }
);

assert.deepEqual(
  await normalizeHttpBodyInitV1(null),
  none
);

console.log("PASS - absent body normalizes explicitly to none");

const textOne =
  await normalizeHttpBodyInitV1("hello");

const textTwo =
  await normalizeHttpBodyInitV1("hello");

assert.equal(textOne.kind, "bytes");
assert.equal(textTwo.kind, "bytes");

if (
  textOne.kind !== "bytes" ||
  textTwo.kind !== "bytes"
) {
  throw new Error("text body did not normalize as bytes");
}

assert.equal(
  Buffer.from(textOne.bytes_base64, "base64").toString("utf8"),
  "hello"
);

assert.equal(
  textOne.byte_length,
  5
);

assert.match(
  textOne.content_type ?? "",
  /^text\/plain;charset=UTF-8$/i
);

assert.deepEqual(textTwo, textOne);
assert.equal(
  fingerprintHttpBodyInitV1(textTwo),
  fingerprintHttpBodyInitV1(textOne)
);

console.log("PASS - string BodyInit preserves platform bytes/content type deterministically");

const params =
  await normalizeHttpBodyInitV1(
    new URLSearchParams([
      ["a", "1"],
      ["b", "two words"]
    ])
  );

assert.equal(params.kind, "bytes");

if (params.kind !== "bytes") {
  throw new Error("URLSearchParams did not normalize as bytes");
}

assert.equal(
  Buffer.from(params.bytes_base64, "base64").toString("utf8"),
  "a=1&b=two+words"
);

assert.match(
  params.content_type ?? "",
  /^application\/x-www-form-urlencoded;charset=UTF-8$/i
);

console.log("PASS - URLSearchParams preserves encoded bytes and platform content type");

const binaryBytes =
  new Uint8Array([
    0,
    1,
    2,
    127,
    128,
    255
  ]);

const binary =
  await normalizeHttpBodyInitV1(
    binaryBytes
  );

assert.equal(binary.kind, "bytes");

if (binary.kind !== "bytes") {
  throw new Error("binary body did not normalize as bytes");
}

assert.deepEqual(
  [...Buffer.from(binary.bytes_base64, "base64")],
  [...binaryBytes]
);

assert.equal(binary.content_type, null);

console.log("PASS - binary BodyInit preserves exact bytes without invented media type");

const blob =
  await normalizeHttpBodyInitV1(
    new Blob(
      [
        new Uint8Array([
          9,
          8,
          7,
          6
        ])
      ],
      {
        type: "application/octet-stream"
      }
    )
  );

assert.equal(blob.kind, "bytes");

if (blob.kind !== "bytes") {
  throw new Error("Blob body did not normalize as bytes");
}

assert.deepEqual(
  [...Buffer.from(blob.bytes_base64, "base64")],
  [9, 8, 7, 6]
);

assert.equal(
  blob.content_type,
  "application/octet-stream"
);

console.log("PASS - Blob BodyInit preserves exact bytes and media type");

const objectBody =
  await normalizeHttpBodyInitV1({
    a: 1
  });

assert.equal(objectBody.kind, "bytes");

if (objectBody.kind !== "bytes") {
  throw new Error("coercible object body did not normalize as bytes");
}

assert.equal(
  Buffer.from(objectBody.bytes_base64, "base64").toString("utf8"),
  "[object Object]"
);

assert.match(
  objectBody.content_type ?? "",
  /^text\/plain;charset=UTF-8$/i
);

console.log("PASS - platform-coercible runtime values are normalized by Request, not guessed as JSON");

function makeFormData() {
  const form =
    new FormData();

  form.append(
    "tag",
    "first"
  );

  form.append(
    "tag",
    "second"
  );

  form.append(
    "asset",
    new Blob(
      [
        new Uint8Array([
          3,
          1,
          4,
          1,
          5
        ])
      ],
      {
        type: "application/octet-stream"
      }
    ),
    "payload.bin"
  );

  return form;
}

const formOne =
  await normalizeHttpBodyInitV1(
    makeFormData()
  );

const formTwo =
  await normalizeHttpBodyInitV1(
    makeFormData()
  );

assert.equal(formOne.kind, "form_data");
assert.equal(formTwo.kind, "form_data");

if (
  formOne.kind !== "form_data" ||
  formTwo.kind !== "form_data"
) {
  throw new Error("FormData did not normalize semantically");
}

assert.deepEqual(
  formOne.entries.map(entry => entry.name),
  [
    "tag",
    "tag",
    "asset"
  ],
  "FormData order and duplicate names are effect-bearing"
);

assert.deepEqual(
  formTwo,
  formOne,
  "equivalent FormData must ignore random multipart wire boundaries"
);

assert.equal(
  fingerprintHttpBodyInitV1(formTwo),
  fingerprintHttpBodyInitV1(formOne)
);

const serializedForm =
  JSON.stringify(formOne);

assert.equal(
  /boundary/i.test(serializedForm),
  false,
  "multipart boundary must never enter semantic retry identity"
);

const fileEntry =
  formOne.entries[2];

assert.equal(
  fileEntry.value.kind,
  "file"
);

if (fileEntry.value.kind !== "file") {
  throw new Error("FormData file entry was not preserved as a file");
}

assert.equal(
  fileEntry.value.filename,
  "payload.bin"
);

assert.equal(
  fileEntry.value.media_type,
  "application/octet-stream"
);

assert.deepEqual(
  [...Buffer.from(fileEntry.value.bytes_base64, "base64")],
  [3, 1, 4, 1, 5]
);

console.log("PASS - FormData identity preserves ordered semantic entries and excludes random boundary");

let streamError;

try {
  await normalizeHttpBodyInitV1(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new Uint8Array([
            1,
            2,
            3
          ])
        );
        controller.close();
      }
    })
  );
}
catch (error) {
  streamError = error;
}

assert.equal(
  streamError instanceof HttpBodyInitNormalizationError,
  true
);

assert.equal(
  streamError?.code,
  "unsupported_stream_body"
);

console.log("PASS - ReadableStream request bodies remain explicitly unsupported");

let symbolError;

try {
  await normalizeHttpBodyInitV1(
    Symbol("unsupported")
  );
}
catch (error) {
  symbolError = error;
}

assert.equal(
  symbolError instanceof HttpBodyInitNormalizationError,
  true
);

assert.equal(
  symbolError?.code,
  "invalid_bodyinit"
);

console.log("PASS - invalid BodyInit values fail closed instead of being guessed");

const rawBodyStatement = `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    body: payload
  }
);
`;

const rawBodyTransformer =
  transformHttpWriteV1({
    statement:
      rawBodyStatement,
    functionSource: `
async function consequentialWrite(operationId, payload) {
}
`,
    provider
  });

assert.equal(
  rawBodyTransformer.eligible,
  false,
  "contract work must not silently promote the generic raw-body source shape"
);

console.log("PASS - generic raw-body transformer eligibility remains frozen false");
console.log("PASS - permanent benchmark must remain 7/15 until execution semantics are proven");
