export function attachHttpResponseReplayV2(replayV1, durableReplayV2) {
  if (!replayV1) return replayV1;

  if (
    !durableReplayV2 ||
    typeof durableReplayV2 !== 'object' ||
    durableReplayV2.receipt === undefined
  ) {
    return replayV1;
  }

  return {
    ...replayV1,
    replay_v2: durableReplayV2.receipt,
  };
}
