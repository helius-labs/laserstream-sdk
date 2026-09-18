package proto

import (
	"testing"

	"google.golang.org/protobuf/proto"
)

func TestAccountIndex(t *testing.T) {
	for _, tc := range []struct {
		wire []byte
		want AccountIndex
	}{
		{wire: nil, want: AccountIndex{Kind: AccountIndexTransaction, Index: 0}},
		{wire: []byte{0x80, 2, 0}, want: AccountIndex{Kind: AccountIndexTransaction, Index: 0}},
		{wire: []byte{0x80, 2, 42}, want: AccountIndex{Kind: AccountIndexTransaction, Index: 42}},
		{wire: []byte{0x80, 2, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1}, want: AccountIndex{Kind: AccountIndexNoTransaction}},
	} {
		var account SubscribeUpdateAccountInfo
		if err := proto.Unmarshal(tc.wire, &account); err != nil {
			t.Fatal(err)
		}
		if got := account.AccountIndex(); got != tc.want {
			t.Fatalf("wire %x: got %+v, want %+v", tc.wire, got, tc.want)
		}
	}
}
