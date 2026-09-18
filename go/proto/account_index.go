package proto

// AccountIndexKind distinguishes transaction writes from writes without a transaction.
type AccountIndexKind uint8

const (
	AccountIndexTransaction AccountIndexKind = iota
	AccountIndexNoTransaction
)

// AccountIndex is a getter-only view of the raw protobuf field.
// Index is zero-based and meaningful only for Kind == AccountIndexTransaction.
type AccountIndex struct {
	Kind  AccountIndexKind
	Index uint64
}

func DecodeAccountIndex(transactionIndex uint64) AccountIndex {
	if transactionIndex == ^uint64(0) {
		return AccountIndex{Kind: AccountIndexNoTransaction}
	}
	return AccountIndex{Kind: AccountIndexTransaction, Index: transactionIndex}
}

// AccountIndex returns Transaction(0) for legacy omission and NoTransaction for UINT64_MAX.
func (account *SubscribeUpdateAccountInfo) AccountIndex() AccountIndex {
	return DecodeAccountIndex(account.GetTransactionIndex())
}
