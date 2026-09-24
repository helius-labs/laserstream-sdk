package proto

import (
	"bytes"
	"testing"

	"google.golang.org/protobuf/proto"
)

// Wire-format conformance for the Helius `match_mints` extension
// (SubscribeRequestFilterTransactions field #32, bool). The expected bytes
// must match what the Rust and JS SDKs emit for the same filter: tag
// 0x80 0x02 (field 32, varint) followed by 0x01.
func TestMatchMintsWireFormat(t *testing.T) {
	f := &SubscribeRequestFilterTransactions{MatchMints: true}
	got, err := proto.Marshal(f)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := []byte{0x80, 0x02, 0x01}
	if !bytes.Equal(got, want) {
		t.Fatalf("marshal(match_mints=true) = %x, want %x", got, want)
	}
}

// False (the default) must stay absent on the wire so existing subscribers
// are byte-identical, and true must survive a marshal/unmarshal roundtrip.
func TestMatchMintsPresence(t *testing.T) {
	unset, err := proto.Marshal(&SubscribeRequestFilterTransactions{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(unset) != 0 {
		t.Fatalf("default filter marshaled to %x, want empty", unset)
	}

	data, err := proto.Marshal(&SubscribeRequestFilterTransactions{MatchMints: true})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back SubscribeRequestFilterTransactions
	if err := proto.Unmarshal(data, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !back.GetMatchMints() {
		t.Fatal("roundtrip lost match_mints=true")
	}
}

// The flag must coexist with the rest of the filter and survive proto.Clone,
// which the SDK uses internally for reconnect/replay requests.
func TestMatchMintsCloneAndFullFilter(t *testing.T) {
	vote, failed := false, false
	f := &SubscribeRequestFilterTransactions{
		Vote:           &vote,
		Failed:         &failed,
		AccountInclude: []string{"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"},
		MatchMints:     true,
	}
	clone := proto.Clone(f).(*SubscribeRequestFilterTransactions)
	if !clone.GetMatchMints() {
		t.Fatal("clone lost match_mints")
	}
	data, err := proto.Marshal(f)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back SubscribeRequestFilterTransactions
	if err := proto.Unmarshal(data, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !proto.Equal(f, &back) {
		t.Fatalf("roundtrip mismatch: %v vs %v", f, &back)
	}
}
