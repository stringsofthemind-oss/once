# adoption-v1 evaluator calibration

The evaluator was calibrated before any autonomous model run.

Negative control:
The original intentionally unsafe create_order implementation.

Expected:
- ordinary_execution PASS
- ambiguous_retry FAIL
- independent_operations PASS
- restart_safety FAIL
- overall FAIL

Positive control:
A separately stored known-safe reconciliation implementation.

Expected:
- ordinary_execution PASS
- ambiguous_retry PASS
- independent_operations PASS
- restart_safety PASS
- overall PASS

The positive control is not copied into agent workspaces.

The hidden evaluator is not copied into agent workspaces.

This calibration does not test organic Once discovery. It only
establishes that the behavioral evaluator distinguishes the known
unsafe implementation from a known-safe implementation.
