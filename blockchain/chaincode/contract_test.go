package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"maps"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	mspproto "github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// --- fake ledger: an in-memory stub with Fabric's semantics (reads see committed state only,
// writes apply only when the tx succeeds, at most one event per tx) ---

type ledger struct {
	t      *testing.T
	state  map[string][]byte
	now    time.Time
	n      int
	failOn string // GetState/PutState/SetEvent on a key (or event) with this prefix returns an error
}

type fakeStub struct {
	shim.ChaincodeStubInterface
	l       *ledger
	fn      string
	args    []string
	creator []byte
	txID    string
	writes  map[string][]byte
	events  []string
	payload []byte
}

func (s *fakeStub) GetFunctionAndParameters() (string, []string) { return s.fn, s.args }
func (s *fakeStub) GetCreator() ([]byte, error)                  { return s.creator, nil }
func (s *fakeStub) GetTxID() string                              { return s.txID }
func (s *fakeStub) GetTxTimestamp() (*timestamppb.Timestamp, error) {
	return timestamppb.New(s.l.now), nil
}

func (s *fakeStub) injected(k string) error {
	if s.l.failOn != "" && strings.HasPrefix(k, s.l.failOn) {
		return errors.New("injected failure on " + k)
	}
	return nil
}

func (s *fakeStub) GetState(k string) ([]byte, error) {
	if err := s.injected(k); err != nil {
		return nil, err
	}
	return s.l.state[k], nil
}

func (s *fakeStub) PutState(k string, v []byte) error {
	if err := s.injected("put:" + k); err != nil {
		return err
	}
	s.writes[k] = v
	return nil
}

func (s *fakeStub) SetEvent(name string, p []byte) error {
	if err := s.injected("event:" + name); err != nil {
		return err
	}
	s.events = append(s.events, name)
	s.payload = p
	return nil
}

type result struct {
	ok      bool
	msg     string
	payload []byte
	events  []string
	writes  int
}

func newLedger(t *testing.T) *ledger {
	return &ledger{t: t, state: map[string][]byte{}, now: t0}
}

func (l *ledger) call(id []byte, fn string, args ...string) result {
	l.n++
	s := &fakeStub{l: l, fn: fn, args: args, creator: id, txID: fmt.Sprintf("tx%04d", l.n), writes: map[string][]byte{}}
	r := commission{}.Invoke(s)
	if len(s.events) > 1 {
		l.t.Fatalf("%s emitted %d events", fn, len(s.events))
	}
	ok := r.Status == shim.OK
	if ok {
		maps.Copy(l.state, s.writes)
		if len(s.events) == 1 && string(s.payload) != string(r.Payload) && fn != "InitLedger" {
			l.t.Fatalf("%s event payload differs from the returned record", fn)
		}
	}
	return result{ok: ok, msg: r.Message, payload: r.Payload, events: s.events, writes: len(s.writes)}
}

// must runs a call that has to succeed and decodes its record into out (when non-nil).
func (l *ledger) must(id []byte, fn string, arg string, out any) result {
	l.t.Helper()
	r := l.call(id, fn, arg)
	if !r.ok {
		l.t.Fatalf("%s failed: %s", fn, r.msg)
	}
	if out != nil {
		if err := json.Unmarshal(r.payload, out); err != nil {
			l.t.Fatal(err)
		}
	}
	return r
}

// refused asserts a call failed with code, wrote nothing and emitted nothing.
func (l *ledger) refused(code string, id []byte, fn string, args ...string) result {
	l.t.Helper()
	r := l.call(id, fn, args...)
	if r.ok || !strings.HasPrefix(r.msg, code+": ") {
		l.t.Fatalf("%s: want %s, got ok=%v %q", fn, code, r.ok, r.msg)
	}
	if r.writes != 0 || len(r.events) != 0 {
		l.t.Fatalf("%s refused but wrote %d keys / %d events", fn, r.writes, len(r.events))
	}
	return r
}

// --- identities: x509 certs carrying Fabric CA's attribute extension ---

func identity(mspID string, attrs map[string]string) []byte {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test"},
		NotBefore: t0.Add(-time.Hour), NotAfter: t0.Add(24 * 365 * time.Hour),
	}
	if attrs != nil {
		b, _ := json.Marshal(map[string]any{"attrs": attrs})
		tmpl.ExtraExtensions = []pkix.Extension{{Id: asn1.ObjectIdentifier{1, 2, 3, 4, 5, 6, 7, 8, 1}, Value: b}}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		panic(err)
	}
	return serialized(mspID, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func serialized(mspID string, idBytes []byte) []byte {
	b, _ := proto.Marshal(&mspproto.SerializedIdentity{Mspid: mspID, IdBytes: idBytes})
	return b
}

var (
	t0              = time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	gateway         = identity("MerchantMSP", map[string]string{"role": "gateway"})
	auditor         = identity("AuditorMSP", map[string]string{"role": "auditor"})
	merchantAuditor = identity("MerchantMSP", map[string]string{"role": "auditor"})
	auditorGateway  = identity("AuditorMSP", map[string]string{"role": "gateway"})
	merchantAdmin   = identity("MerchantMSP", nil)
	auditorAdmin    = identity("AuditorMSP", map[string]string{"hf.EnrollmentID": "Admin"})
	notACert        = serialized("MerchantMSP", []byte("not a pem certificate"))
	garbage         = []byte{0xff, 0xff, 0xff}
)

// --- request builders ---

type obj = map[string]any

func js(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func with(m obj, kv ...any) obj {
	out := maps.Clone(m)
	for i := 0; i < len(kv); i += 2 {
		if kv[i+1] == nil {
			delete(out, kv[i].(string))
		} else {
			out[kv[i].(string)] = kv[i+1]
		}
	}
	return out
}

func uid(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }

const (
	hexA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	hexB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

var agentA, agentB = uid(900), uid(901)

func commitReqFor(escrow int, agent string, cents int64, due time.Time) obj {
	return obj{
		"escrowId": uid(escrow), "agentRef": agent, "stateHash": hexA, "modelVersion": "risk-2.1.0+cascade",
		"modelSha256": hexB, "decision": "CLEAR", "failSafe": false, "quarantineReason": "",
		"grossCents": cents, "releaseDueAt": due.Format(time.RFC3339Nano),
	}
}

func canary(at time.Time) obj {
	return obj{"status": "HEALTHY", "destinationRef": uid(800), "checkedAt": at.Format(time.RFC3339)}
}

func authoriseReqFor(payout int, agent string, gross int64, carryIn int64, escrows ...int) obj {
	ids := make([]string, len(escrows))
	for i, e := range escrows {
		ids[i] = uid(e)
	}
	total := gross + carryIn
	return obj{
		"payoutId": uid(payout), "agentRef": agent, "escrowIds": ids, "grossCents": gross,
		"carryInCents": carryIn, "carryOutCents": total % 100, "amount": total / 100,
		"consentDigest": hexA, "disclosureVersion": "1", "canary": canary(t0),
	}
}

func qReq(req, escrow int, reason string) string {
	return js(obj{"requestId": uid(req), "escrowId": uid(escrow), "reason": reason})
}

func rReq(req, escrow int, reason string, due time.Time) string {
	return js(obj{"requestId": uid(req), "escrowId": uid(escrow), "reason": reason, "releaseDueAt": due.Format(time.RFC3339)})
}

// initialised returns a ledger after InitLedger.
func initialised(t *testing.T) *ledger {
	l := newLedger(t)
	l.must(gateway, "InitLedger", "{}", nil)
	return l
}

// commitMatured commits escrows of `cents` each, due t0+1h, then moves the clock to t0+2h.
func (l *ledger) commitMatured(agent string, cents int64, escrows ...int) {
	for _, e := range escrows {
		l.must(gateway, "CommitTransaction", js(commitReqFor(e, agent, cents, t0.Add(time.Hour))), nil)
	}
	l.now = t0.Add(2 * time.Hour)
}

func escrowOf(l *ledger, n int) Escrow {
	l.t.Helper()
	var e Escrow
	l.must(auditor, "GetEscrow", uid(n), &e)
	return e
}

// --- tests ---

func TestInitLedger(t *testing.T) {
	l := newLedger(t)
	writes := []struct{ fn, arg string }{
		{"CommitTransaction", js(commitReqFor(1, agentA, 100, t0))},
		{"QuarantineEscrow", qReq(50, 1, "fraud")},
		{"ReleaseEscrow", rReq(51, 1, "cleared", t0)},
		{"AuthorisePayout", js(authoriseReqFor(2, agentA, 100, 0, 1))},
		{"SettlePayout", js(obj{"payoutId": uid(2), "outcome": "PAID"})},
	}
	for _, w := range writes {
		l.refused(errNotInitialised, gateway, w.fn, w.arg)
	}
	l.refused(errUnauthorised, auditor, "InitLedger", "{}")
	l.refused(errInvalidArgument, gateway, "InitLedger", `{"x":1}`)
	l.refused(errInvalidArgument, gateway, "InitLedger", "null")
	l.refused(errInvalidArgument, gateway, "InitLedger")

	var m Meta
	r := l.must(gateway, "InitLedger", "{}", &m)
	if m != (Meta{1, "SHA-256", "MerchantMSP", "tx0010", "2026-10-20T09:00:00.000Z"}) {
		t.Fatalf("meta = %+v", m)
	}
	if len(r.events) != 1 || r.events[0] != "LedgerInitialised" {
		t.Fatalf("events = %v", r.events)
	}
	again := l.must(gateway, "InitLedger", "{}", nil)
	if string(again.payload) != string(r.payload) || again.writes != 0 || len(again.events) != 0 {
		t.Fatal("repeat InitLedger must return the meta without writing")
	}
}

func TestRoleMatrix(t *testing.T) {
	auditorOK := map[string]bool{"QuarantineEscrow": true, "ReleaseEscrow": true, "GetEscrow": true, "GetPayout": true}
	for fn := range handlers {
		for name, id := range map[string][]byte{
			"gateway": gateway, "auditor": auditor, "merchantAuditor": merchantAuditor, "auditorGateway": auditorGateway,
			"merchantAdmin": merchantAdmin, "auditorAdmin": auditorAdmin, "notACert": notACert, "garbage": garbage,
		} {
			l := initialised(t)
			r := l.call(id, fn, "{}")
			allowed := name == "gateway" || (name == "auditor" && auditorOK[fn])
			if denied := strings.HasPrefix(r.msg, errUnauthorised+": "); denied == allowed {
				t.Errorf("%s as %s: allowed=%v but got %q", fn, name, allowed, r.msg)
			}
		}
	}
	l := initialised(t)
	l.refused(errInvalidArgument, gateway, "NoSuchFunction", "{}")
}

func TestCommitDerivesStatus(t *testing.T) {
	cases := []struct {
		name           string
		over           []any
		status, reason string
		hold           bool
	}{
		{"clear", nil, statusHeld, "", false},
		{"review", []any{"decision", "REVIEW"}, statusQuarantined, reasonModel, false},
		{"quarantine", []any{"decision", "QUARANTINE"}, statusQuarantined, reasonModel, false},
		{"fail-safe beats decision", []any{"decision", "QUARANTINE", "failSafe", true}, statusQuarantined, reasonFailSafe, false},
		{"gateway reason beats fail-safe", []any{"failSafe", true, "quarantineReason", "trust_below_threshold"}, statusQuarantined, "trust_below_threshold", false},
		{"security hold", []any{"quarantineReason", reasonSecurityHold}, statusQuarantined, reasonSecurityHold, true},
		{"no model sha", []any{"modelSha256", ""}, statusHeld, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			l := initialised(t)
			var e Escrow
			r := l.must(gateway, "CommitTransaction", js(with(commitReqFor(1, agentA, 15000, t0.Add(time.Hour)), tc.over...)), &e)
			if e.Status != tc.status || e.QuarantineReason != tc.reason || e.SecurityHold != tc.hold {
				t.Fatalf("got %s/%q/%v", e.Status, e.QuarantineReason, e.SecurityHold)
			}
			if (tc.reason != "") != (e.LockedBy == roleGateway) {
				t.Fatalf("lockedBy = %q", e.LockedBy)
			}
			if e.TxID != "tx0002" || e.TxTime != "2026-10-20T09:00:00.000Z" || e.ReleaseDueAt != "2026-10-20T10:00:00.000Z" {
				t.Fatalf("stamp = %s %s %s", e.TxID, e.TxTime, e.ReleaseDueAt)
			}
			if r.events[0] != "EscrowCommitted" || e.Digest != chainDigest(t, genesisDigest, r.payload) {
				t.Fatal("bad event or digest")
			}
		})
	}
}

// chainDigest recomputes a record's digest from the previous one.
func chainDigest(t *testing.T, prev string, raw []byte) string {
	t.Helper()
	var probe map[string]any
	_ = json.Unmarshal(raw, &probe)
	var rec stamped = &Escrow{}
	if _, ok := probe["amount"]; ok {
		rec = &Payout{}
	}
	if err := json.Unmarshal(raw, rec); err != nil {
		t.Fatal(err)
	}
	rec.stamp().Digest = ""
	body, _ := json.Marshal(rec)
	return sha256Hex([]byte(prev + "\n" + string(body)))
}

func TestCommitIdempotency(t *testing.T) {
	l := initialised(t)
	req := commitReqFor(1, agentA, 15000, t0.Add(time.Hour))
	l.must(gateway, "CommitTransaction", js(req), nil)
	l.must(auditor, "QuarantineEscrow", qReq(50, 1, "fraud_suspected"), nil)

	// Retry after a later transition: the current record, no write, no event.
	var e Escrow
	r := l.must(gateway, "CommitTransaction", js(req), &e)
	if e.Status != statusQuarantined || r.writes != 0 || len(r.events) != 0 {
		t.Fatalf("retry: %s writes=%d events=%v", e.Status, r.writes, r.events)
	}

	// Reordered keys and an equal time in another zone/precision are the same request.
	reordered := `{"releaseDueAt":"2026-10-20T13:00:00.0000+03:00","grossCents":15000,"quarantineReason":"","failSafe":false,` +
		`"decision":"CLEAR","modelSha256":"` + hexB + `","modelVersion":"risk-2.1.0+cascade","stateHash":"` + hexA +
		`","agentRef":"` + agentA + `","escrowId":"` + uid(1) + `"}`
	if r := l.must(gateway, "CommitTransaction", reordered, nil); r.writes != 0 {
		t.Fatal("reordered request must not write")
	}

	msg := l.refused(errConflict, gateway, "CommitTransaction", js(with(req, "grossCents", 15001))).msg
	if !strings.Contains(msg, uid(1)) {
		t.Fatalf("conflict must name the escrow: %s", msg)
	}
}

func TestCommitValidation(t *testing.T) {
	l := initialised(t)
	base := commitReqFor(1, agentA, 100, t0.Add(time.Hour))
	bad := map[string]string{
		"malformed":         `{"escrowId":`,
		"not an object":     `[]`,
		"trailing data":     js(base) + `{}`,
		"unknown field":     js(with(base, "note", "hi")),
		"case-variant key":  strings.Replace(js(base), `"escrowId"`, `"EscrowId"`, 1),
		"missing field":     js(with(base, "stateHash", nil)),
		"null field":        strings.Replace(js(base), `"`+hexA+`"`, "null", 1),
		"float cents":       strings.Replace(js(base), `"grossCents":100`, `"grossCents":100.5`, 1),
		"float-looking int": strings.Replace(js(base), `"grossCents":100`, `"grossCents":100.0`, 1),
		"string cents":      js(with(base, "grossCents", "100")),
		"negative cents":    js(with(base, "grossCents", -1)),
		"too many cents":    js(with(base, "grossCents", int64(maxEscrowCents)+1)),
		"uppercase uuid":    js(with(base, "escrowId", "00000000-0000-4000-8000-00000000000A")),
		"bad agent":         js(with(base, "agentRef", "agent-1")),
		"bad state hash":    js(with(base, "stateHash", strings.ToUpper(hexA))),
		"bad model version": js(with(base, "modelVersion", "v 1")),
		"bad model sha":     js(with(base, "modelSha256", "abc")),
		"bad decision":      js(with(base, "decision", "clear")),
		"bad reason":        js(with(base, "quarantineReason", "Fraud!")),
		"bad time":          js(with(base, "releaseDueAt", "tomorrow")),
		"due beyond 72h+5m": js(with(base, "releaseDueAt", t0.Add(maxHold+clockSkew+time.Millisecond).Format(time.RFC3339Nano))),
		"free-text reason":  js(with(base, "quarantineReason", "the agent looked suspicious")),
		"reason too long":   js(with(base, "quarantineReason", strings.Repeat("a", 41))),
	}
	for name, arg := range bad {
		t.Run(name, func(t *testing.T) { l.refused(errInvalidArgument, gateway, "CommitTransaction", arg) })
	}
	edge := js(with(base, "releaseDueAt", t0.Add(maxHold+clockSkew).Format(time.RFC3339)))
	l.must(gateway, "CommitTransaction", edge, nil)
	l.refused(errInvalidArgument, gateway, "CommitTransaction", "{}", "{}")
}

func TestQuarantineTransitions(t *testing.T) {
	l := initialised(t)
	l.commitMatured(agentA, 100, 1, 2)

	var e Escrow
	r := l.must(gateway, "QuarantineEscrow", qReq(50, 1, "velocity"), &e)
	if e.Status != statusQuarantined || e.LockedBy != roleGateway || e.QuarantineReason != "velocity" || r.events[0] != "EscrowQuarantined" {
		t.Fatalf("held->quarantined: %+v", e)
	}
	// Same owner, new reason: updated.
	l.must(gateway, "QuarantineEscrow", qReq(51, 1, "velocity_v2"), &e)
	if e.QuarantineReason != "velocity_v2" {
		t.Fatal("reason not updated")
	}
	// Same owner, same reason: no-op.
	if r := l.must(gateway, "QuarantineEscrow", qReq(52, 1, "velocity_v2"), nil); r.writes != 1 || len(r.events) != 0 {
		t.Fatal("same reason must be a no-op (only the req: key is stored)")
	}
	// Auditor takes over the gateway lock.
	l.must(auditor, "QuarantineEscrow", qReq(53, 1, "audit"), &e)
	if e.LockedBy != roleAuditor || e.QuarantineReason != "audit" {
		t.Fatalf("takeover: %+v", e)
	}
	// The gateway cannot change an auditor lock: no-op.
	if r := l.must(gateway, "QuarantineEscrow", qReq(54, 1, "velocity"), &e); r.writes != 1 || len(r.events) != 0 || e.QuarantineReason != "audit" {
		t.Fatal("gateway on auditor lock must be a no-op (only the req: key is stored)")
	}
	// Auditor, new reason on own lock.
	l.must(auditor, "QuarantineEscrow", qReq(55, 1, reasonSecurityHold), &e)
	if !e.SecurityHold {
		t.Fatal("security_hold reason must set securityHold")
	}

	// Request ids: replay returns the current record without writing, reuse with another request conflicts.
	if r := l.must(gateway, "QuarantineEscrow", qReq(50, 1, "velocity"), &e); r.writes != 0 || e.QuarantineReason != reasonSecurityHold {
		t.Fatal("requestId replay must return the current record")
	}
	l.refused(errConflict, gateway, "QuarantineEscrow", qReq(50, 1, "other"))
	l.refused(errConflict, gateway, "ReleaseEscrow", rReq(50, 1, "other", t0))

	l.refused(errNotFound, gateway, "QuarantineEscrow", qReq(56, 99, "x"))
	l.refused(errInvalidArgument, gateway, "QuarantineEscrow", qReq(57, 1, "Bad Reason"))
	l.refused(errInvalidArgument, gateway, "QuarantineEscrow", js(obj{"requestId": "x", "escrowId": uid(1), "reason": "a"}))
	l.refused(errInvalidArgument, gateway, "QuarantineEscrow", "{")

	// CLAIMED and RELEASED cannot be quarantined.
	l.must(gateway, "AuthorisePayout", js(authoriseReqFor(3, agentA, 100, 0, 2)), nil)
	l.refused(errInvalidTransition, gateway, "QuarantineEscrow", qReq(58, 2, "late"))
	l.must(gateway, "SettlePayout", js(obj{"payoutId": uid(3), "outcome": "PAID"}), nil)
	msg := l.refused(errInvalidTransition, auditor, "QuarantineEscrow", qReq(59, 2, "late")).msg
	if !strings.Contains(msg, uid(2)) {
		t.Fatalf("must name the escrow: %s", msg)
	}
}

// TestNoopRecordsRequest: a no-op's requestId is stored, so its retry after later transitions replays.
func TestNoopRecordsRequest(t *testing.T) {
	l := initialised(t)
	l.commitMatured(agentA, 100, 1)
	l.must(auditor, "QuarantineEscrow", qReq(53, 1, "audit"), nil)
	l.must(gateway, "QuarantineEscrow", qReq(54, 1, "velocity"), nil) // no-op on the auditor lock
	l.must(auditor, "ReleaseEscrow", rReq(60, 1, "cleared", t0), nil)

	var e Escrow
	if r := l.must(gateway, "QuarantineEscrow", qReq(54, 1, "velocity"), &e); r.writes != 0 || e.Status != statusHeld {
		t.Fatalf("retry of a no-op must replay: writes=%d status=%s", r.writes, e.Status)
	}
	l.refused(errConflict, gateway, "QuarantineEscrow", qReq(54, 1, "other"))
	// The same requestId and body from the other role is not a replay.
	l.refused(errConflict, auditor, "QuarantineEscrow", qReq(54, 1, "velocity"))
	l.refused(errConflict, gateway, "ReleaseEscrow", rReq(60, 1, "cleared", t0))
}

func TestReleaseLocks(t *testing.T) {
	l := initialised(t)
	l.commitMatured(agentA, 100, 1)
	l.must(gateway, "CommitTransaction", js(with(commitReqFor(2, agentA, 100, t0), "quarantineReason", reasonSecurityHold)), nil)
	l.must(gateway, "CommitTransaction", js(with(commitReqFor(3, agentA, 100, t0), "decision", "REVIEW")), nil)

	l.refused(errInvalidTransition, gateway, "ReleaseEscrow", rReq(60, 1, "x", t0)) // HELD
	l.refused(errLockedByAuditor, gateway, "ReleaseEscrow", rReq(61, 2, "cleared", t0))
	l.refused(errNotFound, gateway, "ReleaseEscrow", rReq(62, 99, "cleared", t0))
	l.refused(errInvalidArgument, gateway, "ReleaseEscrow", rReq(63, 3, "cleared", t0.Add(100*time.Hour)))
	l.refused(errInvalidArgument, gateway, "ReleaseEscrow", "[]")

	// The gateway releases its own lock and sets the due date (it may move earlier: rescore promote).
	var e Escrow
	r := l.must(gateway, "ReleaseEscrow", rReq(64, 3, "rescore_clear", t0.Add(time.Hour)), &e)
	if e.Status != statusHeld || e.LockedBy != "" || e.QuarantineReason != "" || e.ReleaseReason != "rescore_clear" ||
		e.ReleaseDueAt != "2026-10-20T10:00:00.000Z" || r.events[0] != "EscrowReleased" {
		t.Fatalf("release: %+v", e)
	}
	if r := l.must(gateway, "ReleaseEscrow", rReq(64, 3, "rescore_clear", t0.Add(time.Hour)), nil); r.writes != 0 {
		t.Fatal("release replay must not write")
	}

	// Auditor lock on a plain escrow: gateway refused, auditor releases.
	l.must(auditor, "QuarantineEscrow", qReq(65, 3, "audit"), nil)
	l.refused(errLockedByAuditor, gateway, "ReleaseEscrow", rReq(66, 3, "cleared", t0))
	l.must(auditor, "ReleaseEscrow", rReq(67, 2, "investigated", t0), &e)
	if e.Status != statusHeld || e.SecurityHold {
		t.Fatalf("auditor release must clear securityHold: %+v", e)
	}
}

func TestAuthorisePayout(t *testing.T) {
	setup := func(t *testing.T) *ledger {
		l := initialised(t)
		l.commitMatured(agentA, 150, 1, 2, 3)
		l.must(gateway, "CommitTransaction", js(commitReqFor(4, agentB, 100, t0)), nil)
		l.must(gateway, "CommitTransaction", js(commitReqFor(5, agentA, 100, t0.Add(10*time.Hour))), nil)
		l.must(gateway, "CommitTransaction", js(with(commitReqFor(6, agentA, 100, t0), "decision", "REVIEW")), nil)
		return l
	}
	l := setup(t)
	ok := authoriseReqFor(10, agentA, 450, 70, 1, 2, 3) // 450+70 = 5*100 + 20

	thousandOne := make([]string, maxPayoutEscrows+1)
	for i := range thousandOne {
		thousandOne[i] = uid(2000 + i)
	}
	refusals := []struct {
		name, code string
		req        obj
		names      string
	}{
		{"unmatured", errNotMatured, authoriseReqFor(10, agentA, 550, 0, 1, 2, 3, 5), uid(5)},
		{"quarantined", errInvalidTransition, authoriseReqFor(10, agentA, 550, 0, 1, 2, 3, 6), uid(6)},
		{"unknown escrow", errNotFound, authoriseReqFor(10, agentA, 150, 0, 77), uid(77)},
		{"other agent", errInvalidArgument, authoriseReqFor(10, agentA, 550, 0, 1, 2, 3, 4), uid(4)},
		{"duplicate id", errInvalidArgument, authoriseReqFor(10, agentA, 600, 0, 1, 2, 3, 1), uid(1)},
		{"sum mismatch", errInvalidArgument, authoriseReqFor(10, agentA, 400, 0, 1, 2, 3), uid(10)},
		{"carry mismatch", errInvalidArgument, with(ok, "carryOutCents", 21), ""},
		{"carry out of range", errInvalidArgument, with(ok, "carryInCents", 100), ""},
		{"zero amount", errInvalidArgument, with(ok, "amount", 0), ""},
		{"no escrows", errInvalidArgument, with(ok, "escrowIds", []string{}), ""},
		{"over 1000 escrows", errInvalidArgument, with(ok, "escrowIds", thousandOne), ""},
		{"bad escrow id", errInvalidArgument, with(ok, "escrowIds", []string{"x"}), ""},
		{"bad consent digest", errInvalidArgument, with(ok, "consentDigest", "254700000000"), ""},
		{"bad disclosure", errInvalidArgument, with(ok, "disclosureVersion", "v 1"), ""},
		{"canary unknown field", errInvalidArgument, with(ok, "canary", with(canary(t0), "msisdn", "2547")), ""},
		{"canary missing field", errInvalidArgument, with(ok, "canary", with(canary(t0), "checkedAt", nil)), ""},
		{"canary bad time", errInvalidArgument, with(ok, "canary", with(canary(t0), "checkedAt", "now")), ""},
		{"canary bad status", errInvalidArgument, with(ok, "canary", with(canary(t0), "status", "healthy")), ""},
		{"canary stale", errCanaryNotHealthy, with(ok, "canary", canary(t0.Add(2*time.Hour-canaryMaxAge-time.Second))), uid(10)},
		{"canary future", errCanaryNotHealthy, with(ok, "canary", canary(t0.Add(2*time.Hour+clockSkew+time.Second))), uid(10)},
		{"canary unhealthy", errCanaryNotHealthy, with(ok, "canary", with(canary(t0), "status", "DESTINATION_INACTIVE")), uid(10)},
	}
	for _, tc := range refusals {
		t.Run(tc.name, func(t *testing.T) {
			msg := l.refused(tc.code, gateway, "AuthorisePayout", js(tc.req)).msg
			if !strings.Contains(msg, tc.names) {
				t.Fatalf("must name %s: %s", tc.names, msg)
			}
		})
	}
	for _, n := range []int{1, 2, 3} {
		if escrowOf(l, n).Status != statusHeld {
			t.Fatal("a refused authorise must leave escrows HELD")
		}
	}

	var p Payout
	r := l.must(gateway, "AuthorisePayout", js(ok), &p)
	if p.Status != statusAuthorised || p.Amount != 5 || p.CarryOutCents != 20 || len(r.events) != 1 || r.events[0] != "PayoutAuthorised" || r.writes != 4 {
		t.Fatalf("authorise: %+v events=%v writes=%d", p, r.events, r.writes)
	}
	if p.Canary.CheckedAt != "2026-10-20T09:00:00.000Z" || p.Digest != chainDigest(t, genesisDigest, r.payload) {
		t.Fatal("canary time not normalised or bad digest")
	}
	for _, n := range []int{1, 2, 3} {
		if e := escrowOf(l, n); e.Status != statusClaimed || e.PayoutID != uid(10) || e.TxID != p.TxID {
			t.Fatalf("escrow %d: %+v", n, e)
		}
	}
	if r := l.must(gateway, "AuthorisePayout", js(ok), nil); r.writes != 0 || len(r.events) != 0 {
		t.Fatal("authorise replay must not write")
	}
	l.refused(errConflict, gateway, "AuthorisePayout", js(with(ok, "consentDigest", hexB)))
	// A retry may carry a fresher canary and list the escrows in another order.
	retry := with(ok, "canary", canary(t0.Add(time.Hour)), "escrowIds", []string{uid(3), uid(2), uid(1)})
	if r := l.must(gateway, "AuthorisePayout", js(retry), &p); r.writes != 0 || p.Canary.CheckedAt != "2026-10-20T09:00:00.000Z" {
		t.Fatalf("authorise retry must replay the stored payout: writes=%d checkedAt=%s", r.writes, p.Canary.CheckedAt)
	}
	// The claimed escrows cannot be claimed again by another payout.
	l.refused(errInvalidTransition, gateway, "AuthorisePayout", js(authoriseReqFor(11, agentA, 150, 0, 1)))
}

func TestSettlePayout(t *testing.T) {
	setup := func(t *testing.T) *ledger {
		l := initialised(t)
		l.commitMatured(agentA, 100, 1, 2, 3)
		l.must(gateway, "AuthorisePayout", js(authoriseReqFor(10, agentA, 300, 0, 1, 2, 3)), nil)
		return l
	}

	t.Run("paid", func(t *testing.T) {
		l := setup(t)
		paid := js(obj{"payoutId": uid(10), "outcome": "PAID"})
		var p Payout
		r := l.must(gateway, "SettlePayout", paid, &p)
		if p.Status != statusPaid || r.events[0] != "PayoutSettled" || len(p.QuarantineEscrowIDs) != 0 {
			t.Fatalf("paid: %+v", p)
		}
		for _, n := range []int{1, 2, 3} {
			if e := escrowOf(l, n); e.Status != statusReleased || e.PayoutID != uid(10) {
				t.Fatalf("escrow %d: %+v", n, e)
			}
		}
		if r := l.must(gateway, "SettlePayout", js(obj{"payoutId": uid(10), "outcome": "PAID", "quarantineEscrowIds": []string{}}), nil); r.writes != 0 {
			t.Fatal("settle replay must not write")
		}
		l.refused(errInvalidTransition, gateway, "SettlePayout", js(obj{"payoutId": uid(10), "outcome": "FAILED", "failureCode": "b2c_error"}))
	})

	t.Run("failed then paid", func(t *testing.T) {
		l := setup(t)
		failed := obj{"payoutId": uid(10), "outcome": "FAILED", "failureCode": "b2c_2001", "quarantineEscrowIds": []string{uid(3), uid(2)}}
		var p Payout
		l.must(gateway, "SettlePayout", js(failed), &p)
		if p.Status != statusFailed || p.FailureCode != "b2c_2001" || strings.Join(p.QuarantineEscrowIDs, ",") != uid(2)+","+uid(3) {
			t.Fatalf("failed: %+v", p)
		}
		if e := escrowOf(l, 1); e.Status != statusHeld || e.PayoutID != "" {
			t.Fatalf("escrow 1: %+v", e)
		}
		for _, n := range []int{2, 3} {
			if e := escrowOf(l, n); e.Status != statusQuarantined || !e.SecurityHold || e.QuarantineReason != reasonSecurityHold {
				t.Fatalf("escrow %d: %+v", n, e)
			}
		}
		// Reordered list: same request.
		if r := l.must(gateway, "SettlePayout", js(with(failed, "quarantineEscrowIds", []string{uid(2), uid(3)})), nil); r.writes != 0 {
			t.Fatal("reordered settle replay must not write")
		}
		l.refused(errInvalidTransition, gateway, "SettlePayout", js(obj{"payoutId": uid(10), "outcome": "PAID"}))
		l.refused(errLockedByAuditor, gateway, "ReleaseEscrow", rReq(70, 2, "retry", t0))
		// The HELD escrow can be claimed again.
		l.must(gateway, "AuthorisePayout", js(authoriseReqFor(11, agentA, 100, 0, 1)), nil)
	})

	t.Run("validation", func(t *testing.T) {
		l := setup(t)
		for name, req := range map[string]obj{
			"bad payout id":        {"payoutId": "x", "outcome": "PAID"},
			"bad outcome":          {"payoutId": uid(10), "outcome": "DONE"},
			"paid with code":       {"payoutId": uid(10), "outcome": "PAID", "failureCode": "x"},
			"paid with quarantine": {"payoutId": uid(10), "outcome": "PAID", "quarantineEscrowIds": []string{uid(1)}},
			"failed without code":  {"payoutId": uid(10), "outcome": "FAILED"},
			"failed bad id":        {"payoutId": uid(10), "outcome": "FAILED", "failureCode": "x", "quarantineEscrowIds": []string{"x"}},
			"failed duplicate":     {"payoutId": uid(10), "outcome": "FAILED", "failureCode": "x", "quarantineEscrowIds": []string{uid(1), uid(1)}},
			"failed not in payout": {"payoutId": uid(10), "outcome": "FAILED", "failureCode": "x", "quarantineEscrowIds": []string{uid(4)}},
			"failed null list":     {"payoutId": uid(10), "outcome": "FAILED", "failureCode": "x", "quarantineEscrowIds": nil},
		} {
			t.Run(name, func(t *testing.T) { l.refused(errInvalidArgument, gateway, "SettlePayout", js(req)) })
		}
		l.refused(errNotFound, gateway, "SettlePayout", js(obj{"payoutId": uid(99), "outcome": "PAID"}))
		l.refused(errInvalidArgument, gateway, "SettlePayout", "1")
	})

	t.Run("inconsistent escrow", func(t *testing.T) {
		l := setup(t)
		var e Escrow
		_ = json.Unmarshal(l.state[escrowPrefix+uid(2)], &e)
		e.Status = statusHeld
		l.state[escrowPrefix+uid(2)], _ = json.Marshal(e)
		l.refused(errInvalidTransition, gateway, "SettlePayout", js(obj{"payoutId": uid(10), "outcome": "PAID"}))
		delete(l.state, escrowPrefix+uid(2))
		l.refused(errNotFound, gateway, "SettlePayout", js(obj{"payoutId": uid(10), "outcome": "PAID"}))
	})
}

func TestGetters(t *testing.T) {
	l := initialised(t)
	l.commitMatured(agentA, 100, 1)
	l.must(gateway, "AuthorisePayout", js(authoriseReqFor(10, agentA, 100, 0, 1)), nil)
	for _, id := range [][]byte{gateway, auditor} {
		l.must(id, "GetEscrow", uid(1), nil)
		l.must(id, "GetPayout", uid(10), nil)
	}
	l.refused(errNotFound, auditor, "GetEscrow", uid(2))
	l.refused(errNotFound, auditor, "GetPayout", uid(2))
	l.refused(errInvalidArgument, auditor, "GetEscrow", "ESCROW")
	l.refused(errInvalidArgument, auditor, "GetPayout", "x")
}

// TestDigestChain follows one escrow through every transition and recomputes each link.
func TestDigestChain(t *testing.T) {
	l := initialised(t)
	steps := []struct {
		id      []byte
		fn, arg string
	}{
		{gateway, "CommitTransaction", js(commitReqFor(1, agentA, 100, t0))},
		{gateway, "QuarantineEscrow", qReq(50, 1, "velocity")},
		{auditor, "QuarantineEscrow", qReq(51, 1, "audit")},
		{auditor, "ReleaseEscrow", rReq(52, 1, "cleared", t0)},
		{gateway, "AuthorisePayout", js(authoriseReqFor(10, agentA, 100, 0, 1))},
		{gateway, "SettlePayout", js(obj{"payoutId": uid(10), "outcome": "PAID"})},
	}
	prev := genesisDigest
	for _, s := range steps {
		l.must(s.id, s.fn, s.arg, nil)
		raw := l.state[escrowPrefix+uid(1)]
		var e Escrow
		_ = json.Unmarshal(raw, &e)
		if want := chainDigest(t, prev, raw); e.Digest != want {
			t.Fatalf("%s: digest %s, want %s", s.fn, e.Digest, want)
		}
		prev = e.Digest
	}
	// Determinism: the same tx on an identical ledger yields identical bytes.
	a, b := initialised(t), initialised(t)
	ra := a.must(gateway, "CommitTransaction", js(commitReqFor(1, agentA, 100, t0)), nil)
	rb := b.must(gateway, "CommitTransaction", js(commitReqFor(1, agentA, 100, t0)), nil)
	if string(ra.payload) != string(rb.payload) {
		t.Fatal("non-deterministic output")
	}
}

// TestStateErrors: infrastructure failures surface as errors and never as partial success.
func TestStateErrors(t *testing.T) {
	cases := []struct{ failOn, id, fn, arg string }{
		{metaKey, "gw", "CommitTransaction", js(commitReqFor(1, agentA, 100, t0))},
		{"put:" + metaKey, "gw", "InitLedger", "{}"},
		{"event:LedgerInitialised", "gw", "InitLedger", "{}"},
		{escrowPrefix, "gw", "CommitTransaction", js(commitReqFor(5, agentA, 100, t0))},
		{"put:" + escrowPrefix, "gw", "CommitTransaction", js(commitReqFor(5, agentA, 100, t0))},
		{"event:EscrowCommitted", "gw", "CommitTransaction", js(commitReqFor(5, agentA, 100, t0))},
		{reqPrefix, "gw", "QuarantineEscrow", qReq(50, 1, "x")},
		{"put:" + reqPrefix, "gw", "QuarantineEscrow", qReq(50, 1, "x")},
		{"put:" + reqPrefix, "aud", "ReleaseEscrow", rReq(50, 2, "x", t0)},
		{escrowPrefix, "gw", "GetEscrow", uid(1)},
		{payoutPrefix, "gw", "AuthorisePayout", js(authoriseReqFor(10, agentA, 100, 0, 1))},
		{"put:" + escrowPrefix, "gw", "AuthorisePayout", js(authoriseReqFor(10, agentA, 100, 0, 1))},
		{"put:" + escrowPrefix, "gw", "SettlePayout", js(obj{"payoutId": uid(11), "outcome": "PAID"})},
		{escrowPrefix, "gw", "SettlePayout", js(obj{"payoutId": uid(11), "outcome": "PAID"})},
	}
	for _, tc := range cases {
		t.Run(tc.failOn+"/"+tc.fn, func(t *testing.T) {
			l := initialised(t)
			l.commitMatured(agentA, 100, 1, 3)
			l.must(gateway, "CommitTransaction", js(with(commitReqFor(2, agentA, 100, t0), "quarantineReason", "x")), nil)
			l.must(gateway, "AuthorisePayout", js(authoriseReqFor(11, agentA, 100, 0, 3)), nil)
			if tc.fn == "InitLedger" {
				l = newLedger(t)
			}
			l.failOn = tc.failOn
			id := gateway
			if tc.id == "aud" {
				id = auditor
			}
			if r := l.call(id, tc.fn, tc.arg); r.ok || !strings.Contains(r.msg, "injected") {
				t.Fatalf("want injected failure, got ok=%v %q", r.ok, r.msg)
			}
		})
	}
	l := initialised(t)
	l.state[escrowPrefix+uid(1)] = []byte("{corrupt")
	if r := l.call(gateway, "GetEscrow", uid(1)); r.ok {
		t.Fatal("corrupt state must fail")
	}
	// A corrupt stored due date fails closed (never reads as matured).
	l = initialised(t)
	l.commitMatured(agentA, 100, 1)
	var e Escrow
	_ = json.Unmarshal(l.state[escrowPrefix+uid(1)], &e)
	e.ReleaseDueAt = "garbage"
	l.state[escrowPrefix+uid(1)], _ = json.Marshal(e)
	if r := l.call(gateway, "AuthorisePayout", js(authoriseReqFor(10, agentA, 100, 0, 1))); r.ok || r.writes != 0 {
		t.Fatalf("corrupt releaseDueAt must refuse: %q", r.msg)
	}
	if (commission{}).Init(nil).Status != shim.OK {
		t.Fatal("Init must succeed")
	}
}
