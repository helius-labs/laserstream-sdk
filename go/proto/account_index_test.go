package proto

import (
	"encoding/hex"
	"testing"

	"google.golang.org/protobuf/proto"
)

func TestAccountTransactionIndex(t *testing.T) {
	for _, tc := range []struct {
		wire    string
		present bool
		value   uint64
	}{
		{"", false, 0}, {"4800", true, 0}, {"482a", true, 42},
		{"48ffffffffffffffffff01", true, ^uint64(0)},
	} {
		info, err := hex.DecodeString(tc.wire)
		if err != nil {
			t.Fatal(err)
		}
		for _, block := range []bool{false, true} {
			innerTag, outerTag := byte(0x0a), byte(0x12)
			if block {
				innerTag, outerTag = 0x5a, 0x2a
			}
			nested := append([]byte{innerTag, byte(len(info))}, info...)
			wire := append([]byte{outerTag, byte(len(nested))}, nested...)
			var update SubscribeUpdate
			if err := proto.Unmarshal(wire, &update); err != nil {
				t.Fatal(err)
			}
			var account *SubscribeUpdateAccountInfo
			if block {
				account = update.GetBlock().Accounts[0]
			} else {
				account = update.GetAccount().Account
			}
			check := func(account *SubscribeUpdateAccountInfo) {
				t.Helper()
				if (account.TransactionIndex != nil) != tc.present || account.GetTransactionIndex() != tc.value {
					t.Fatalf("block=%v wire=%s: presence/value mismatch: %v", block, tc.wire, account)
				}
			}
			check(account)
			encoded, err := proto.Marshal(&update)
			if err != nil {
				t.Fatal(err)
			}
			var replay SubscribeUpdate
			if err := proto.Unmarshal(encoded, &replay); err != nil {
				t.Fatal(err)
			}
			if block {
				check(replay.GetBlock().Accounts[0])
			} else {
				check(replay.GetAccount().Account)
			}
		}
	}
}
