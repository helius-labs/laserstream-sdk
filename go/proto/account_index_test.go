package proto

import "testing"

func TestAccountTransactionIndex(t *testing.T) {
	for _, tc := range []struct {
		wire uint64
		want AccountTransactionIndex
	}{
		{0, AccountTransactionIndex{Kind: TransactionWrite, Index: 0}},
		{42, AccountTransactionIndex{Kind: TransactionWrite, Index: 42}},
		{^uint64(0), AccountTransactionIndex{Kind: NoTransaction}},
	} {
		account := SubscribeUpdateAccountInfo{TransactionIndex: tc.wire}
		if got := account.AccountTransactionIndex(); got != tc.want {
			t.Fatalf("index %d: got %+v, want %+v", tc.wire, got, tc.want)
		}
	}
}
