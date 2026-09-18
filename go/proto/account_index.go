package proto

// AccountTransactionIndexKind distinguishes transaction writes from native writes.
type AccountTransactionIndexKind uint8

const (
	TransactionWrite AccountTransactionIndexKind = iota
	NoTransaction
)

// AccountTransactionIndex is a read-only typed view of the raw protobuf uint64.
// Index is zero-based and is meaningful only for Kind == TransactionWrite.
// The decoder maps MAX to NoTransaction. Generated raw fields remain available
// for protobuf compatibility; this view provides no setter or encoder.
type AccountTransactionIndex struct {
	Kind  AccountTransactionIndexKind
	Index uint64
}

func DecodeAccountTransactionIndex(value uint64) AccountTransactionIndex {
	if value == ^uint64(0) {
		return AccountTransactionIndex{Kind: NoTransaction}
	}
	return AccountTransactionIndex{Kind: TransactionWrite, Index: value}
}

// AccountTransactionIndex returns TransactionWrite(0) for legacy omitted field 32.
func (account *SubscribeUpdateAccountInfo) AccountTransactionIndex() AccountTransactionIndex {
	return DecodeAccountTransactionIndex(account.GetTransactionIndex())
}
