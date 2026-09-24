# Once adoption-v1

Frozen adoption/discovery benchmark.

This experiment measures two different questions.

## Cold lane

Can an autonomous coding agent encounter an ambiguous-outcome
duplicate-side-effect problem and independently choose a safe
solution?

A particularly important observation is whether Once is discovered
without being named.

## Warm lane

If the agent is told only that Once should be used, can it
independently discover the public installation and integration path
and implement it correctly?

## Experimental rule

Prompts and scoring criteria are frozen before the first model run.

Do not improve a prompt after seeing a result and count the new run
as part of the same protocol.

## Cost control

Initial pilot:

- 1 cold run
- 1 warm run

Only expand the sample after the harness and scoring pipeline have
been validated.

## Important distinction

Cold discovery and warm integration are separate measurements.

Failure to discover Once in the cold lane does not imply that Once
fails technically.

Likewise, successful warm integration does not demonstrate organic
discovery.
