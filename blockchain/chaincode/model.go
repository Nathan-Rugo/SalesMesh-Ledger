// Records, requests and input validation for the commission escrow chaincode (DLT-02, #9).
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"regexp"
	"strings"
	"time"
)

// Error codes: every failure is "CODE: detail" (see docs/architecture/commission-chaincode.md).
const (
	errUnauthorised      = "UNAUTHORISED"
	errInvalidArgument   = "INVALID_ARGUMENT"
	errNotInitialised    = "NOT_INITIALISED"
	errNotFound          = "NOT_FOUND"
	errConflict          = "CONFLICT"
	errInvalidTransition = "INVALID_TRANSITION"
	errNotMatured        = "NOT_MATURED"
	errCanaryNotHealthy  = "CANARY_NOT_HEALTHY"
	errLockedByAuditor   = "LOCKED_BY_AUDITOR"
)

// Escrow and payout states (the gateway's names).
const (
	statusHeld        = "HELD"
	statusQuarantined = "QUARANTINED"
	statusClaimed     = "CLAIMED"
	statusReleased    = "RELEASED"
	statusAuthorised  = "AUTHORISED"
	statusPaid        = "PAID"
	statusFailed      = "FAILED"
)

const (
	roleGateway = "gateway"
	roleAuditor = "auditor"

	reasonSecurityHold = "security_hold"
	reasonFailSafe     = "fail_safe"
	reasonModel        = "model_decision"

	genesisDigest = "0000000000000000000000000000000000000000000000000000000000000000"
	timeLayout    = "2006-01-02T15:04:05.000Z"

	clockSkew        = 5 * time.Minute
	maxHold          = 72 * time.Hour
	canaryMaxAge     = 24 * time.Hour
	maxPayoutEscrows = 1000
	maxEscrowCents   = 10_000_000_000_000                // 10^13
	maxPayoutCents   = maxEscrowCents * maxPayoutEscrows // cannot overflow int64
)

var (
	reUUID          = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	reHex64         = regexp.MustCompile(`^[0-9a-f]{64}$`)
	reCode          = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
	reModelVersion  = regexp.MustCompile(`^[A-Za-z0-9._+-]{1,64}$`)
	reDisclosure    = regexp.MustCompile(`^[A-Za-z0-9._-]{1,20}$`)
	reCanaryStatus  = regexp.MustCompile(`^[A-Z][A-Z_]{0,19}$`)
	validDecisions  = map[string]bool{"CLEAR": true, "REVIEW": true, "QUARANTINE": true}
	validSettlement = map[string]bool{statusPaid: true, statusFailed: true}
)

type ccError struct{ code, detail string }

func (e *ccError) Error() string { return e.code + ": " + e.detail }

func fail(code, format string, a ...any) error { return &ccError{code, fmt.Sprintf(format, a...)} }

// Stamp is the tx that last changed a record, plus the record's digest-chain head.
type Stamp struct {
	TxID   string `json:"txId"`
	TxTime string `json:"txTime"`
	Digest string `json:"digest,omitempty"` // empty only while the digest itself is computed
}

func (s *Stamp) stamp() *Stamp { return s }

type Meta struct {
	SchemaVersion   int    `json:"schemaVersion"`
	DigestAlgorithm string `json:"digestAlgorithm"`
	MSPID           string `json:"mspId"`
	TxID            string `json:"txId"`
	TxTime          string `json:"txTime"`
}

type Escrow struct {
	EscrowID         string `json:"escrowId"`
	AgentRef         string `json:"agentRef"`
	StateHash        string `json:"stateHash"`
	ModelVersion     string `json:"modelVersion"`
	ModelSha256      string `json:"modelSha256"`
	Decision         string `json:"decision"`
	FailSafe         bool   `json:"failSafe"`
	GrossCents       int64  `json:"grossCents"`
	Status           string `json:"status"`
	QuarantineReason string `json:"quarantineReason"`
	LockedBy         string `json:"lockedBy"`
	SecurityHold     bool   `json:"securityHold"`
	ReleaseDueAt     string `json:"releaseDueAt"`
	ReleaseReason    string `json:"releaseReason"`
	PayoutID         string `json:"payoutId"`
	RequestHash      string `json:"requestHash"`
	Stamp
}

type Canary struct {
	Status         string `json:"status"`
	DestinationRef string `json:"destinationRef"`
	CheckedAt      string `json:"checkedAt"`
}

type Payout struct {
	PayoutID            string   `json:"payoutId"`
	AgentRef            string   `json:"agentRef"`
	EscrowIDs           []string `json:"escrowIds"`
	GrossCents          int64    `json:"grossCents"`
	CarryInCents        int64    `json:"carryInCents"`
	CarryOutCents       int64    `json:"carryOutCents"`
	Amount              int64    `json:"amount"`
	ConsentDigest       string   `json:"consentDigest"`
	DisclosureVersion   string   `json:"disclosureVersion"`
	Canary              Canary   `json:"canary"`
	Status              string   `json:"status"`
	FailureCode         string   `json:"failureCode"`
	QuarantineEscrowIDs []string `json:"quarantineEscrowIds"`
	RequestHash         string   `json:"requestHash"`
	SettleHash          string   `json:"settleHash"`
	Stamp
}

// requestRef is stored at req:<requestId> so a retried Quarantine/Release is answered without a write.
type requestRef struct {
	Hash     string `json:"hash"`
	EscrowID string `json:"escrowId"`
}

// Requests. Every field is required unless its tag says omitempty.
type initReq struct{}

type commitReq struct {
	EscrowID         string `json:"escrowId"`
	AgentRef         string `json:"agentRef"`
	StateHash        string `json:"stateHash"`
	ModelVersion     string `json:"modelVersion"`
	ModelSha256      string `json:"modelSha256"`
	Decision         string `json:"decision"`
	FailSafe         bool   `json:"failSafe"`
	QuarantineReason string `json:"quarantineReason"`
	GrossCents       int64  `json:"grossCents"`
	ReleaseDueAt     string `json:"releaseDueAt"`
}

type quarantineReq struct {
	RequestID string `json:"requestId"`
	EscrowID  string `json:"escrowId"`
	Reason    string `json:"reason"`
}

type releaseReq struct {
	RequestID    string `json:"requestId"`
	EscrowID     string `json:"escrowId"`
	Reason       string `json:"reason"`
	ReleaseDueAt string `json:"releaseDueAt"`
}

type authoriseReq struct {
	PayoutID          string   `json:"payoutId"`
	AgentRef          string   `json:"agentRef"`
	EscrowIDs         []string `json:"escrowIds"`
	GrossCents        int64    `json:"grossCents"`
	CarryInCents      int64    `json:"carryInCents"`
	CarryOutCents     int64    `json:"carryOutCents"`
	Amount            int64    `json:"amount"`
	ConsentDigest     string   `json:"consentDigest"`
	DisclosureVersion string   `json:"disclosureVersion"`
	Canary            Canary   `json:"canary"`
}

type settleReq struct {
	PayoutID            string   `json:"payoutId"`
	Outcome             string   `json:"outcome"`
	FailureCode         string   `json:"failureCode,omitempty"`
	QuarantineEscrowIDs []string `json:"quarantineEscrowIds,omitempty"`
}

// decodeStrict parses exactly one JSON object into v: unknown, case-variant, missing or null
// required fields, trailing data and non-integer numbers for integer fields are all rejected.
func decodeStrict(arg string, v any) error {
	dec := json.NewDecoder(strings.NewReader(arg))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fail(errInvalidArgument, "malformed request: %v", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return fail(errInvalidArgument, "malformed request: trailing data")
	}
	return checkKeys([]byte(arg), reflect.TypeOf(v).Elem(), "")
}

// checkKeys enforces exact-case keys and required fields (encoding/json matches keys case-insensitively).
func checkKeys(raw []byte, t reflect.Type, path string) error {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return fail(errInvalidArgument, "malformed request: %s must be an object", path)
	}
	known := map[string]bool{}
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		name, opts, _ := strings.Cut(f.Tag.Get("json"), ",")
		known[name] = true
		r, ok := m[name]
		if !ok || bytes.Equal(r, []byte("null")) {
			if opts == "omitempty" && !ok {
				continue
			}
			return fail(errInvalidArgument, "missing field %s%s", path, name)
		}
		if f.Type.Kind() == reflect.Struct {
			if err := checkKeys(r, f.Type, path+name+"."); err != nil {
				return err
			}
		}
	}
	for k := range m {
		if !known[k] {
			return fail(errInvalidArgument, "unknown field %s%s", path, k)
		}
	}
	return nil
}

// requestHash is the SHA-256 of the function name and the decoded, normalised request (struct
// marshalling is field-ordered, so equal requests hash equally whatever their key order).
func requestHash(fn string, req any) string {
	b, _ := json.Marshal(req) // plain structs of strings/ints/bools: cannot fail
	return sha256Hex([]byte(fn + "\n" + string(b)))
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func checkUUID(field, v string) error {
	if !reUUID.MatchString(v) {
		return fail(errInvalidArgument, "%s must be a lowercase canonical uuid", field)
	}
	return nil
}

func checkMatch(re *regexp.Regexp, field, v string) error {
	if !re.MatchString(v) {
		return fail(errInvalidArgument, "%s must match %s", field, re)
	}
	return nil
}

func checkRange(field string, v, lo, hi int64) error {
	if v < lo || v > hi {
		return fail(errInvalidArgument, "%s must be an integer in %d..%d", field, lo, hi)
	}
	return nil
}

// parseTime accepts RFC3339 and returns it as UTC with milliseconds (the stored form).
func parseTime(field, v string) (time.Time, string, error) {
	t, err := time.Parse(time.RFC3339Nano, v)
	if err != nil {
		return time.Time{}, "", fail(errInvalidArgument, "%s must be an RFC3339 time", field)
	}
	t = t.UTC().Truncate(time.Millisecond)
	return t, t.Format(timeLayout), nil
}

func formatTime(t time.Time) string { return t.UTC().Truncate(time.Millisecond).Format(timeLayout) }
