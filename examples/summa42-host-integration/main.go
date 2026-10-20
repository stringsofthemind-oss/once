// Controlled integration fixture, copied INSIDE the pinned Summa42 checkout.
// It runs actual operations/execution/resource services, not an LLM or Box CLI.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/SofiaFlux/summa42/internal/approvals"
	"github.com/SofiaFlux/summa42/internal/domain"
	"github.com/SofiaFlux/summa42/internal/execution"
	"github.com/SofiaFlux/summa42/internal/operations"
	"github.com/SofiaFlux/summa42/internal/policy"
	"github.com/SofiaFlux/summa42/internal/purpose"
	"github.com/SofiaFlux/summa42/internal/resources"
	state "github.com/SofiaFlux/summa42/internal/state/sqlite"
	"github.com/SofiaFlux/summa42/internal/testutil"
)

type allowFixturePolicy struct{}

func (allowFixturePolicy) Evaluate(_ context.Context, in policy.PolicyInput) (domain.PolicyDecision, error) {
	return domain.PolicyDecision{ID: domain.NewID("decision"), Outcome: domain.PolicyAllow,
		PolicySetID: "fixture-policy", PolicySetHash: "fixture-v1", PolicyCapabilitiesHash: "fixture-caps",
		InputDigest: "fixture-input", EvaluatedAt: in.Now}, nil
}

type bridgeProvider struct{ url, token string }

func (p bridgeProvider) Name() string                              { return "once-orders" }
func (p bridgeProvider) Capability() string                        { return "external:once-orders" }
func (p bridgeProvider) EnforcementLevel() domain.EnforcementLevel { return domain.EnforcementEnforced }
func (p bridgeProvider) AdapterVersion() string                    { return "once-reference-v1" }
func (p bridgeProvider) AdapterVersionSemanticallyRelevant() bool  { return true }
func (p bridgeProvider) CanonicalIntent(d operations.IntentDescriptor) ([]byte, error) {
	v, ok := d.(testutil.PurchaseIntent)
	if !ok || v.SKU != "SKU-1" || v.Quantity != 2 {
		return nil, errors.New("unsupported fixture intent")
	}
	return json.Marshal(v)
}
func (p bridgeProvider) CostProfile(d operations.IntentDescriptor) (operations.CostProfile, error) {
	if _, err := p.CanonicalIntent(d); err != nil {
		return operations.CostProfile{}, err
	}
	return operations.CostProfile{MaxExposure: 20, Enforceability: resources.Enforceability{CostControl: resources.CostTechnicallyCapped, RequireHardCap: true, Source: "controlled-local-order-fixture"}}, nil
}
func (p bridgeProvider) request(ctx context.Context, mode string, r operations.ProviderDispatchRequest) (operations.ProviderOutcome, error) {
	body, err := json.Marshal(r)
	if err != nil {
		return operations.ProviderOutcome{}, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", p.url+"/"+mode, bytes.NewReader(body))
	if err != nil {
		return operations.ProviderOutcome{}, err
	}
	req.Header.Set("Authorization", "Bearer "+p.token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}
	response, err := client.Do(req)
	if err != nil {
		return operations.ProviderOutcome{State: domain.OperationOutcomeUnknown}, domain.ErrOutcomeUnknown
	}
	defer response.Body.Close()
	var out struct {
		Status string `json:"status"`
		Result struct {
			ProviderReference string `json:"providerReference"`
		} `json:"result"`
	}
	if response.StatusCode != 200 || json.NewDecoder(response.Body).Decode(&out) != nil || out.Status != "CONFIRMED" || out.Result.ProviderReference == "" {
		return operations.ProviderOutcome{State: domain.OperationOutcomeUnknown}, domain.ErrOutcomeUnknown
	}
	return operations.ProviderOutcome{State: domain.OperationConfirmedEffect, ProviderReference: out.Result.ProviderReference, ActualCost: 20}, nil
}
func (p bridgeProvider) Dispatch(ctx context.Context, r operations.ProviderDispatchRequest) (operations.ProviderOutcome, error) {
	return p.request(ctx, "dispatch", r)
}
func (p bridgeProvider) LookupOutcome(ctx context.Context, r operations.ProviderDispatchRequest) (operations.ProviderOutcome, error) {
	return p.request(ctx, "lookup", r)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if os.Getenv("ONCE_FIXTURE_ONLY") != "disposable-summa42" {
		return errors.New("explicit disposable fixture admission required")
	}
	home, mode := os.Getenv("ONCE_SUMMA42_FIXTURE"), os.Getenv("ONCE_SUMMA42_STAGE")
	if home == "" || !filepath.IsAbs(home) {
		return errors.New("absolute disposable fixture directory required")
	}
	ctx := context.Background()
	dbpath := filepath.Join(home, "summa42.sqlite")
	if mode != "init" {
		if _, err := os.Stat(dbpath); err != nil {
			return errors.New("original Summa42 history missing; recovery cannot bootstrap")
		}
	}
	if mode == "init" {
		if _, err := os.Stat(dbpath); err == nil {
			return errors.New("fixture already initialized")
		}
	}
	store, err := state.Open(ctx, dbpath)
	if err != nil {
		return err
	}
	defer store.DB().Close()
	clk := testutil.NewClock(time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC))
	exec := execution.New(store, clk, purpose.New(store, clk))
	ledger := resources.New(store, clk)
	provider := bridgeProvider{url: os.Getenv("ONCE_BRIDGE_URL"), token: os.Getenv("ONCE_BRIDGE_TOKEN")}
	svc := operations.New(store, clk, exec, allowFixturePolicy{}, ledger, approvals.New(store, clk), "collective-once-fixture", provider)
	const taskID domain.ID = "task-once-fixture"
	emit := func(op domain.ExternalOperation, attemptID domain.ID, gate string) error {
		var reservation string
		if err := store.DB().QueryRowContext(ctx, `SELECT state FROM resource_reservations WHERE reservation_id=?`, op.ReservationID).Scan(&reservation); err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"pid": os.Getpid(), "attemptId": attemptID, "taskId": taskID, "operationId": op.ID, "effectSlotId": op.EffectSlotID, "state": op.State, "reservation": reservation, "providerReference": op.ProviderReference, "hostGate": gate})
	}
	var attempt domain.Attempt
	if mode == "init" {
		now := clk.Now().UTC().Format(time.RFC3339Nano)
		if _, err := store.DB().ExecContext(ctx, `INSERT INTO policy_sets(policy_set_id,version,module_name,module,policy_hash,capabilities_hash,active,created_at) VALUES('fixture-policy',1,'fixture.rego','package fixture','fixture-v1','fixture-caps',1,?)`, now); err != nil {
			return err
		}
		if _, err := store.DB().ExecContext(ctx, `INSERT INTO resource_envelopes(envelope_id,hard_limit,created_at) VALUES('fixture-envelope',1000,?)`, now); err != nil {
			return err
		}
		if _, err := store.DB().ExecContext(ctx, `INSERT INTO tasks(task_id,purpose_kind,purpose_id,state,current_fence,acceptance_criteria_json,required_capabilities_json,required_enforcement,authority_ceiling_json,resource_envelope_id,priority,created_at,updated_at) VALUES(?,'OWNER_DIRECTIVE','owner-fixture','ELIGIBLE',0,'[]','[]','ENFORCED','["external:once-orders"]','fixture-envelope',0,?,?)`, taskID, now, now); err != nil {
			return err
		}
		attempt, err = exec.StartAttempt(ctx, taskID, "once-fixture", time.Hour)
	} else {
		var previous string
		if err := store.DB().QueryRowContext(ctx, `SELECT current_attempt_id FROM tasks WHERE task_id=?`, taskID).Scan(&previous); err != nil {
			return err
		}
		if mode == "dispatch" {
			// Dispatch uses the existing live attempt from initialization.
			attempt.ID = domain.ID(previous)
		} else {
			// Reference host progression gate: a replacement PROCESS may reconcile,
			// but may not create another Attempt while this intent is unresolved.
			var priorID domain.ID
			if err := store.DB().QueryRowContext(ctx, `SELECT o.operation_id FROM external_operations o JOIN effect_slots e ON e.effect_slot_id=o.effect_slot_id WHERE e.task_id=? AND e.trusted_slot_key='owner-admitted-order-slot' ORDER BY o.operation_sequence DESC LIMIT 1`, taskID).Scan(&priorID); err != nil {
				return err
			}
			prior, reconcileErr := operations.NewReconciler(svc).Reconcile(ctx, priorID)
			if reconcileErr != nil && !errors.Is(reconcileErr, domain.ErrOutcomeUnknown) {
				return reconcileErr
			}
			if prior.State != domain.OperationConfirmedEffect {
				return emit(prior, domain.ID(previous), "BLOCKED_UNRESOLVED")
			}
			if err := exec.RevokeLease(ctx, domain.ID(previous)); err != nil {
				return err
			}
			attempt, err = exec.StartAttempt(ctx, taskID, "replacement-"+fmt.Sprint(os.Getpid()), time.Hour)
		}
	}
	if err != nil {
		return err
	}
	op, err := svc.Prepare(ctx, operations.PrepareRequest{AttemptID: attempt.ID, Provider: provider.Name(), TrustedSlotKey: "owner-admitted-order-slot", Intent: testutil.PurchaseIntent{SKU: "SKU-1", Quantity: 2}, Risk: "LOW"})
	if err != nil {
		return err
	}
	if mode != "init" {
		op, err = svc.Dispatch(ctx, op.ID, attempt.ID)
		if err != nil && !errors.Is(err, domain.ErrOutcomeUnknown) {
			return err
		}
	}
	return emit(op, attempt.ID, "OPEN")
}
