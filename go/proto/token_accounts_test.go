package proto

import (
	"bytes"
	"testing"

	"google.golang.org/protobuf/proto"
)

// Wire-format conformance for the Helius `token_accounts` extension
// (SubscribeRequestFilterTransactions field #30, enum
// TokenAccountExpansionControlFlag). The expected bytes must match what the
// Rust and JS SDKs emit for the same filter: tag 0xF0 0x01 (field 30,
// varint) followed by the enum value.
func TestTokenAccountsWireFormat(t *testing.T) {
	cases := []struct {
		name string
		mode TokenAccountExpansionControlFlag
		want []byte
	}{
		{"ALL", TokenAccountExpansionControlFlag_ALL, []byte{0xF0, 0x01, 0x00}},
		{"BALANCE_CHANGED", TokenAccountExpansionControlFlag_BALANCE_CHANGED, []byte{0xF0, 0x01, 0x01}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &SubscribeRequestFilterTransactions{TokenAccounts: tc.mode.Enum()}
			got, err := proto.Marshal(f)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if !bytes.Equal(got, tc.want) {
				t.Fatalf("marshal(%s) = %x, want %x", tc.name, got, tc.want)
			}
		})
	}
}

// Unset must stay absent on the wire (no expansion), and explicit presence —
// including the zero value ALL — must survive a marshal/unmarshal roundtrip.
func TestTokenAccountsPresence(t *testing.T) {
	unset, err := proto.Marshal(&SubscribeRequestFilterTransactions{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(unset) != 0 {
		t.Fatalf("unset filter marshaled to %x, want empty", unset)
	}

	for _, mode := range []TokenAccountExpansionControlFlag{
		TokenAccountExpansionControlFlag_ALL,
		TokenAccountExpansionControlFlag_BALANCE_CHANGED,
	} {
		data, err := proto.Marshal(&SubscribeRequestFilterTransactions{TokenAccounts: mode.Enum()})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var back SubscribeRequestFilterTransactions
		if err := proto.Unmarshal(data, &back); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if back.TokenAccounts == nil || *back.TokenAccounts != mode {
			t.Fatalf("roundtrip of %v lost presence or value: %v", mode, back.TokenAccounts)
		}
	}
}

// The field must coexist with the rest of the filter and survive proto.Clone,
// which the SDK uses internally for reconnect/replay requests.
func TestTokenAccountsCloneAndFullFilter(t *testing.T) {
	vote, failed := false, false
	f := &SubscribeRequestFilterTransactions{
		Vote:           &vote,
		Failed:         &failed,
		AccountInclude: []string{"vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg"},
		TokenAccounts:  TokenAccountExpansionControlFlag_BALANCE_CHANGED.Enum(),
	}
	clone := proto.Clone(f).(*SubscribeRequestFilterTransactions)
	if clone.GetTokenAccounts() != TokenAccountExpansionControlFlag_BALANCE_CHANGED {
		t.Fatalf("clone lost token_accounts: %v", clone.TokenAccounts)
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
