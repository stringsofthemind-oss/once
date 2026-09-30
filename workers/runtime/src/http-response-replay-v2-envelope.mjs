function decodeReplayText(receipt) {
  const binary = atob(String(receipt.body_base64 || ''));
  const bytes = Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

/**
 * Add byte-exact replay-v2 evidence to the established v1 HTTP replay envelope
 * only when both durable records agree on the observables they share.
 *
 * Any missing, corrupt, or contradictory v2 evidence leaves v1 unchanged.
 * Legacy text replay is never promoted to native Response capability by
 * inference.
 */
export function attachHttpResponseReplayV2(replayV1, replayV2Record) {
  if (
    !replayV1 ||
    typeof replayV1 !== 'object' ||
    Array.isArray(replayV1)
  ) {
    return replayV1;
  }

  const receipt = replayV2Record?.receipt;
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt)
  ) {
    return replayV1;
  }

  try {
    if (Number(replayV1.status) !== Number(receipt.status)) {
      return replayV1;
    }

    const bodyText = decodeReplayText(receipt);
    if (String(replayV1.body_text ?? '') !== bodyText) {
      return replayV1;
    }

    return {
      ...replayV1,
      replay_v2: receipt,
    };
  }
  catch {
    return replayV1;
  }
}
