// Router, role checks, guarded transitions and the per-record digest chain.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/v2/pkg/cid"
	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-protos-go-apiv2/peer"
)

const (
	metaKey      = "meta:ledger"
	escrowPrefix = "escrow:"
	payoutPrefix = "payout:"
	reqPrefix    = "req:"
)

type commission struct{}

type call struct {
	stub  shim.ChaincodeStubInterface
	role  string
	mspID string
	txID  string
	now   time.Time
}

type handler struct {
	run     func(*call, string) ([]byte, error)
	auditor bool // the auditor may call it too (the gateway may call everything)
	write   bool // needs InitLedger first
}

var handlers = map[string]handler{
	"InitLedger":        {run: initLedger},
	"CommitTransaction": {run: commitTransaction, write: true},
	"QuarantineEscrow":  {run: quarantineEscrow, auditor: true, write: true},
	"ReleaseEscrow":     {run: releaseEscrow, auditor: true, write: true},
	"AuthorisePayout":   {run: authorisePayout, write: true},
	"SettlePayout":      {run: settlePayout, write: true},
	"GetEscrow":         {run: getEscrow, auditor: true},
	"GetPayout":         {run: getPayout, auditor: true},
}

func (commission) Init(shim.ChaincodeStubInterface) *peer.Response { return shim.Success(nil) }

func (commission) Invoke(stub shim.ChaincodeStubInterface) *peer.Response {
	out, err := dispatch(stub)
	if err != nil {
		return shim.Error(err.Error())
	}
	return shim.Success(out)
}

func dispatch(stub shim.ChaincodeStubInterface) ([]byte, error) {
	fn, args := stub.GetFunctionAndParameters()
	h, ok := handlers[fn]
	if !ok {
		return nil, fail(errInvalidArgument, "unknown function %q", fn)
	}
	c, err := newCall(stub)
	if err != nil {
		return nil, err
	}
	if c.role != roleGateway && !(c.role == roleAuditor && h.auditor) {
		return nil, fail(errUnauthorised, "%s may not be called by %s role %q", fn, c.mspID, c.role)
	}
	if len(args) != 1 {
		return nil, fail(errInvalidArgument, "%s takes exactly one argument", fn)
	}
	if h.write {
		if m, err := stub.GetState(metaKey); err != nil {
			return nil, err
		} else if m == nil {
			return nil, fail(errNotInitialised, "call InitLedger first")
		}
	}
	return h.run(c, args[0])
}

// newCall resolves the caller's role: deny by default, and a role counts only from its own org's MSP.
func newCall(stub shim.ChaincodeStubInterface) (*call, error) {
	id, err := cid.New(stub)
	if err != nil {
		return nil, fail(errUnauthorised, "unreadable caller identity: %v", err)
	}
	cert, _ := id.GetX509Certificate()
	msp, _ := id.GetMSPID()
	attr, _, err := id.GetAttributeValue("role")
	if cert == nil || err != nil {
		return nil, fail(errUnauthorised, "caller from %s has no x509 role attribute", msp)
	}
	ts, err := stub.GetTxTimestamp()
	if err != nil {
		return nil, err
	}
	c := &call{stub: stub, mspID: msp, txID: stub.GetTxID(), now: ts.AsTime().UTC().Truncate(time.Millisecond)}
	switch {
	case attr == roleGateway && msp == "MerchantMSP", attr == roleAuditor && msp == "AuditorMSP":
		c.role = attr
	}
	return c, nil
}

// --- state helpers ---

type stamped interface{ stamp() *Stamp }

func getJSON(c *call, key string, v any) ([]byte, error) {
	raw, err := c.stub.GetState(key)
	if err != nil || raw == nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return nil, err
	}
	return raw, nil
}

func mustEscrow(c *call, id string) (*Escrow, []byte, error) {
	e := &Escrow{}
	raw, err := getJSON(c, escrowPrefix+id, e)
	if err == nil && raw == nil {
		err = fail(errNotFound, "escrow %s", id)
	}
	return e, raw, err
}

func mustPayout(c *call, id string) (*Payout, []byte, error) {
	p := &Payout{}
	raw, err := getJSON(c, payoutPrefix+id, p)
	if err == nil && raw == nil {
		err = fail(errNotFound, "payout %s", id)
	}
	return p, raw, err
}

// save stamps the record with this tx, extends its digest chain
// (sha256(prev‖"\n"‖json(record without digest)), genesis 64 zeros), writes it and emits event if set.
func save(c *call, key string, rec stamped, event string) ([]byte, error) {
	s := rec.stamp()
	prev := s.Digest
	if prev == "" {
		prev = genesisDigest
	}
	s.TxID, s.TxTime, s.Digest = c.txID, formatTime(c.now), ""
	body, err := json.Marshal(rec)
	if err != nil {
		return nil, err
	}
	s.Digest = sha256Hex(append([]byte(prev+"\n"), body...))
	out, err := json.Marshal(rec)
	if err != nil {
		return nil, err
	}
	if err := c.stub.PutState(key, out); err != nil {
		return nil, err
	}
	if event != "" {
		if err := c.stub.SetEvent(event, out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// dueTime parses a release date and caps it at tx + 72 h + skew.
func dueTime(c *call, field, v string) (time.Time, string, error) {
	t, s, err := parseTime(field, v)
	if err == nil && t.After(c.now.Add(maxHold+clockSkew)) {
		err = fail(errInvalidArgument, "%s is more than 72h after the tx time", field)
	}
	return t, s, err
}

// replay answers a retried Quarantine/Release: same requestId and request -> the current record.
func replay(c *call, requestID, hash string) (bool, []byte, error) {
	ref := &requestRef{}
	raw, err := getJSON(c, reqPrefix+requestID, ref)
	if err != nil || raw == nil {
		return false, nil, err
	}
	if ref.Hash != hash {
		return true, nil, fail(errConflict, "request %s was already used for a different request on escrow %s", requestID, ref.EscrowID)
	}
	_, cur, err := mustEscrow(c, ref.EscrowID)
	return true, cur, err
}

func putRequest(c *call, requestID, hash, escrowID string) error {
	b, _ := json.Marshal(requestRef{Hash: hash, EscrowID: escrowID})
	return c.stub.PutState(reqPrefix+requestID, b)
}

// --- functions ---

func initLedger(c *call, arg string) ([]byte, error) {
	if err := decodeStrict(arg, &initReq{}); err != nil {
		return nil, err
	}
	if raw, err := c.stub.GetState(metaKey); err != nil || raw != nil {
		return raw, err
	}
	out, _ := json.Marshal(Meta{SchemaVersion: 1, DigestAlgorithm: "SHA-256", MSPID: c.mspID, TxID: c.txID, TxTime: formatTime(c.now)})
	if err := c.stub.PutState(metaKey, out); err != nil {
		return nil, err
	}
	if err := c.stub.SetEvent("LedgerInitialised", out); err != nil {
		return nil, err
	}
	return out, nil
}

func commitTransaction(c *call, arg string) ([]byte, error) {
	var r commitReq
	if err := decodeStrict(arg, &r); err != nil {
		return nil, err
	}
	err := errors.Join(
		checkUUID("escrowId", r.EscrowID), checkUUID("agentRef", r.AgentRef),
		checkMatch(reHex64, "stateHash", r.StateHash), checkMatch(reModelVersion, "modelVersion", r.ModelVersion),
		checkRange("grossCents", r.GrossCents, 0, maxEscrowCents))
	if err == nil && r.ModelSha256 != "" {
		err = checkMatch(reHex64, "modelSha256", r.ModelSha256)
	}
	if err == nil && !validDecisions[r.Decision] {
		err = fail(errInvalidArgument, "decision must be CLEAR, REVIEW or QUARANTINE")
	}
	if err == nil && r.QuarantineReason != "" {
		err = checkMatch(reCode, "quarantineReason", r.QuarantineReason)
	}
	if err == nil {
		_, r.ReleaseDueAt, err = dueTime(c, "releaseDueAt", r.ReleaseDueAt)
	}
	if err != nil {
		return nil, firstErr(err)
	}
	hash := requestHash("CommitTransaction", r)

	var cur Escrow
	if raw, err := getJSON(c, escrowPrefix+r.EscrowID, &cur); err != nil {
		return nil, err
	} else if raw != nil {
		if cur.RequestHash == hash {
			return raw, nil
		}
		return nil, fail(errConflict, "escrow %s already committed with a different request", r.EscrowID)
	}

	// Fail-safe (NFR-08): the chaincode derives the status itself.
	reason := r.QuarantineReason
	switch {
	case reason != "":
	case r.FailSafe:
		reason = reasonFailSafe
	case r.Decision != "CLEAR":
		reason = reasonModel
	}
	e := &Escrow{
		EscrowID: r.EscrowID, AgentRef: r.AgentRef, StateHash: r.StateHash, ModelVersion: r.ModelVersion,
		ModelSha256: r.ModelSha256, Decision: r.Decision, FailSafe: r.FailSafe, GrossCents: r.GrossCents,
		Status: statusHeld, ReleaseDueAt: r.ReleaseDueAt, RequestHash: hash,
	}
	if reason != "" {
		e.Status, e.QuarantineReason, e.LockedBy, e.SecurityHold = statusQuarantined, reason, roleGateway, reason == reasonSecurityHold
	}
	return save(c, escrowPrefix+e.EscrowID, e, "EscrowCommitted")
}

func quarantineEscrow(c *call, arg string) ([]byte, error) {
	var r quarantineReq
	if err := decodeStrict(arg, &r); err != nil {
		return nil, err
	}
	if err := errors.Join(checkUUID("requestId", r.RequestID), checkUUID("escrowId", r.EscrowID), checkMatch(reCode, "reason", r.Reason)); err != nil {
		return nil, firstErr(err)
	}
	hash := requestHash("QuarantineEscrow/"+c.role, r) // role-bound: the other role reusing it is a CONFLICT
	if done, out, err := replay(c, r.RequestID, hash); done || err != nil {
		return out, err
	}
	e, raw, err := mustEscrow(c, r.EscrowID)
	if err != nil {
		return nil, err
	}
	switch {
	case e.Status == statusHeld:
		e.Status, e.LockedBy = statusQuarantined, c.role
	case e.Status != statusQuarantined:
		return nil, fail(errInvalidTransition, "escrow %s is %s", e.EscrowID, e.Status)
	case c.role == roleAuditor && e.LockedBy != roleAuditor:
		e.LockedBy = roleAuditor // the auditor takes over a gateway lock
	case c.role == e.LockedBy && e.QuarantineReason != r.Reason:
		// same owner, new reason
	default:
		// no-op: no escrow write, no event; the requestId is still recorded so a later retry replays
		return raw, putRequest(c, r.RequestID, hash, e.EscrowID)
	}
	e.QuarantineReason, e.ReleaseReason = r.Reason, ""
	e.SecurityHold = e.SecurityHold || r.Reason == reasonSecurityHold
	if err := putRequest(c, r.RequestID, hash, e.EscrowID); err != nil {
		return nil, err
	}
	return save(c, escrowPrefix+e.EscrowID, e, "EscrowQuarantined")
}

func releaseEscrow(c *call, arg string) ([]byte, error) {
	var r releaseReq
	if err := decodeStrict(arg, &r); err != nil {
		return nil, err
	}
	err := errors.Join(checkUUID("requestId", r.RequestID), checkUUID("escrowId", r.EscrowID), checkMatch(reCode, "reason", r.Reason))
	if err == nil {
		_, r.ReleaseDueAt, err = dueTime(c, "releaseDueAt", r.ReleaseDueAt)
	}
	if err != nil {
		return nil, firstErr(err)
	}
	hash := requestHash("ReleaseEscrow/"+c.role, r)
	if done, out, err := replay(c, r.RequestID, hash); done || err != nil {
		return out, err
	}
	e, _, err := mustEscrow(c, r.EscrowID)
	if err != nil {
		return nil, err
	}
	if e.Status != statusQuarantined {
		return nil, fail(errInvalidTransition, "escrow %s is %s", e.EscrowID, e.Status)
	}
	if (e.LockedBy == roleAuditor || e.SecurityHold) && c.role != roleAuditor {
		return nil, fail(errLockedByAuditor, "escrow %s can be released only by the auditor", e.EscrowID)
	}
	e.Status, e.ReleaseDueAt, e.LockedBy, e.QuarantineReason, e.ReleaseReason = statusHeld, r.ReleaseDueAt, "", "", r.Reason
	if c.role == roleAuditor {
		e.SecurityHold = false
	}
	if err := putRequest(c, r.RequestID, hash, e.EscrowID); err != nil {
		return nil, err
	}
	return save(c, escrowPrefix+e.EscrowID, e, "EscrowReleased")
}

func authorisePayout(c *call, arg string) ([]byte, error) {
	var r authoriseReq
	if err := decodeStrict(arg, &r); err != nil {
		return nil, err
	}
	err := errors.Join(
		checkUUID("payoutId", r.PayoutID), checkUUID("agentRef", r.AgentRef),
		checkRange("grossCents", r.GrossCents, 0, maxPayoutCents),
		checkRange("carryInCents", r.CarryInCents, 0, 99), checkRange("carryOutCents", r.CarryOutCents, 0, 99),
		checkRange("amount", r.Amount, 1, maxPayoutCents/100+1),
		checkMatch(reHex64, "consentDigest", r.ConsentDigest), checkMatch(reDisclosure, "disclosureVersion", r.DisclosureVersion),
		checkMatch(reCanaryStatus, "canary.status", r.Canary.Status), checkUUID("canary.destinationRef", r.Canary.DestinationRef))
	if err == nil && (len(r.EscrowIDs) < 1 || len(r.EscrowIDs) > maxPayoutEscrows) {
		err = fail(errInvalidArgument, "escrowIds must hold 1..%d ids", maxPayoutEscrows)
	}
	seen := map[string]bool{}
	for _, id := range r.EscrowIDs {
		if err == nil {
			err = checkUUID("escrowIds[]", id)
		}
		if err == nil && seen[id] {
			err = fail(errInvalidArgument, "escrow %s is listed twice", id)
		}
		seen[id] = true
	}
	if err == nil && r.GrossCents+r.CarryInCents != r.Amount*100+r.CarryOutCents {
		err = fail(errInvalidArgument, "grossCents + carryInCents must equal amount*100 + carryOutCents")
	}
	var checked time.Time
	if err == nil {
		checked, r.Canary.CheckedAt, err = parseTime("canary.checkedAt", r.Canary.CheckedAt)
	}
	if err != nil {
		return nil, firstErr(err)
	}
	slices.Sort(r.EscrowIDs) // a set: order carries no meaning
	hashed := r
	hashed.Canary.CheckedAt = "" // a retry may carry a fresher canary; the stored payout keeps the first
	hash := requestHash("AuthorisePayout", hashed)

	var cur Payout
	if raw, err := getJSON(c, payoutPrefix+r.PayoutID, &cur); err != nil {
		return nil, err
	} else if raw != nil {
		if cur.RequestHash == hash {
			return raw, nil
		}
		return nil, fail(errConflict, "payout %s already authorised with a different request", r.PayoutID)
	}

	// Canary = payout preflight attested by the gateway: refuse (never quarantine) unless fresh and HEALTHY.
	if r.Canary.Status != "HEALTHY" || checked.Before(c.now.Add(-canaryMaxAge)) || checked.After(c.now.Add(clockSkew)) {
		return nil, fail(errCanaryNotHealthy, "payout %s: canary %s checked %s", r.PayoutID, r.Canary.Status, r.Canary.CheckedAt)
	}

	escrows := make([]*Escrow, 0, len(r.EscrowIDs))
	var sum int64
	for _, id := range r.EscrowIDs {
		e, _, err := mustEscrow(c, id)
		if err != nil {
			return nil, err
		}
		due, _, err := parseTime("releaseDueAt", e.ReleaseDueAt)
		if err != nil {
			return nil, fmt.Errorf("escrow %s: corrupt stored releaseDueAt: %w", id, err)
		}
		switch {
		case e.Status != statusHeld || e.SecurityHold:
			return nil, fail(errInvalidTransition, "escrow %s is %s (securityHold=%t)", id, e.Status, e.SecurityHold)
		case e.AgentRef != r.AgentRef:
			return nil, fail(errInvalidArgument, "escrow %s belongs to another agent", id)
		case due.After(c.now):
			return nil, fail(errNotMatured, "escrow %s matures at %s", id, e.ReleaseDueAt)
		}
		sum += e.GrossCents
		escrows = append(escrows, e)
	}
	if sum != r.GrossCents {
		return nil, fail(errInvalidArgument, "payout %s: escrows sum to %d cents, not grossCents %d", r.PayoutID, sum, r.GrossCents)
	}
	for _, e := range escrows {
		e.Status, e.PayoutID = statusClaimed, r.PayoutID
		if _, err := save(c, escrowPrefix+e.EscrowID, e, ""); err != nil {
			return nil, err
		}
	}
	p := &Payout{
		PayoutID: r.PayoutID, AgentRef: r.AgentRef, EscrowIDs: r.EscrowIDs, GrossCents: r.GrossCents,
		CarryInCents: r.CarryInCents, CarryOutCents: r.CarryOutCents, Amount: r.Amount, ConsentDigest: r.ConsentDigest,
		DisclosureVersion: r.DisclosureVersion, Canary: r.Canary, Status: statusAuthorised,
		QuarantineEscrowIDs: []string{}, RequestHash: hash,
	}
	return save(c, payoutPrefix+p.PayoutID, p, "PayoutAuthorised")
}

func settlePayout(c *call, arg string) ([]byte, error) {
	var r settleReq
	if err := decodeStrict(arg, &r); err != nil {
		return nil, err
	}
	err := checkUUID("payoutId", r.PayoutID)
	switch {
	case err != nil:
	case !validSettlement[r.Outcome]:
		err = fail(errInvalidArgument, "outcome must be PAID or FAILED")
	case r.Outcome == statusPaid && (r.FailureCode != "" || len(r.QuarantineEscrowIDs) > 0):
		err = fail(errInvalidArgument, "failureCode and quarantineEscrowIds are for FAILED only")
	case r.Outcome == statusFailed:
		err = checkMatch(reCode, "failureCode", r.FailureCode)
	}
	slices.Sort(r.QuarantineEscrowIDs) // a set: order carries no meaning
	for i, id := range r.QuarantineEscrowIDs {
		if err == nil {
			err = checkUUID("quarantineEscrowIds[]", id)
		}
		if err == nil && i > 0 && r.QuarantineEscrowIDs[i-1] == id {
			err = fail(errInvalidArgument, "escrow %s is listed twice", id)
		}
	}
	if err != nil {
		return nil, err
	}
	hash := requestHash("SettlePayout", r)

	p, raw, err := mustPayout(c, r.PayoutID)
	if err != nil {
		return nil, err
	}
	if p.Status != statusAuthorised {
		if p.SettleHash == hash {
			return raw, nil
		}
		return nil, fail(errInvalidTransition, "payout %s is already %s", p.PayoutID, p.Status)
	}
	for _, id := range r.QuarantineEscrowIDs {
		if !slices.Contains(p.EscrowIDs, id) {
			return nil, fail(errInvalidArgument, "escrow %s is not in payout %s", id, p.PayoutID)
		}
	}
	escrows := make([]*Escrow, 0, len(p.EscrowIDs))
	for _, id := range p.EscrowIDs {
		e, _, err := mustEscrow(c, id)
		if err != nil {
			return nil, err
		}
		if e.Status != statusClaimed || e.PayoutID != p.PayoutID {
			return nil, fail(errInvalidTransition, "escrow %s is %s, not CLAIMED by payout %s", id, e.Status, p.PayoutID)
		}
		escrows = append(escrows, e)
	}
	for _, e := range escrows {
		switch {
		case r.Outcome == statusPaid:
			e.Status = statusReleased
		case slices.Contains(r.QuarantineEscrowIDs, e.EscrowID):
			e.Status, e.PayoutID, e.LockedBy, e.QuarantineReason, e.SecurityHold = statusQuarantined, "", roleGateway, reasonSecurityHold, true
		default:
			e.Status, e.PayoutID = statusHeld, ""
		}
		if _, err := save(c, escrowPrefix+e.EscrowID, e, ""); err != nil {
			return nil, err
		}
	}
	p.Status, p.FailureCode, p.SettleHash = r.Outcome, r.FailureCode, hash
	if r.QuarantineEscrowIDs != nil {
		p.QuarantineEscrowIDs = r.QuarantineEscrowIDs
	}
	return save(c, payoutPrefix+p.PayoutID, p, "PayoutSettled")
}

func getEscrow(c *call, id string) ([]byte, error) {
	if err := checkUUID("escrowId", id); err != nil {
		return nil, err
	}
	_, raw, err := mustEscrow(c, id)
	return raw, err
}

func getPayout(c *call, id string) ([]byte, error) {
	if err := checkUUID("payoutId", id); err != nil {
		return nil, err
	}
	_, raw, err := mustPayout(c, id)
	return raw, err
}

// firstErr unwraps errors.Join so the caller sees one "CODE: detail".
func firstErr(err error) error {
	if j, ok := err.(interface{ Unwrap() []error }); ok {
		return j.Unwrap()[0]
	}
	return err
}
