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
		{nil, AccountIndex{Kind: TransactionIndex, Index: 0}},
		{[]byte{0x80, 2, 0}, AccountIndex{Kind: TransactionIndex, Index: 0}},
		{[]byte{0x80, 2, 42, 0x88, 2, 9}, AccountIndex{Kind: TransactionIndex, Index: 42}},
		{[]byte{0x80, 2, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1}, AccountIndex{Kind: NativeOperation, OperationCount: 0}},
		{[]byte{0x80, 2, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1, 0x88, 2, 7}, AccountIndex{Kind: NativeOperation, OperationCount: 7}},
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
