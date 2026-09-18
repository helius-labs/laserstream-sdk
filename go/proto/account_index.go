package proto

// AccountIndexKind distinguishes transaction writes from native operations.
type AccountIndexKind uint8

const (
	TransactionIndex AccountIndexKind = iota
	NativeOperation
)

// AccountIndex is a getter-only view of the raw protobuf fields.
// Index is zero-based and meaningful only for Kind == TransactionIndex.
// OperationCount is zero-based per pubkey/bank and meaningful only for Kind == NativeOperation.
type AccountIndex struct {
	Kind           AccountIndexKind
	Index          uint64
	OperationCount uint64
}

func DecodeAccountIndex(transactionIndex, nativeOperationCount uint64) AccountIndex {
	if transactionIndex == ^uint64(0) {
		return AccountIndex{Kind: NativeOperation, OperationCount: nativeOperationCount}
	}
	return AccountIndex{Kind: TransactionIndex, Index: transactionIndex}
}

// AccountIndex returns TransactionIndex(0) for legacy omission and NativeOperation(0)
// for legacy MAX without a native operation count.
func (account *SubscribeUpdateAccountInfo) AccountIndex() AccountIndex {
	return DecodeAccountIndex(account.GetTransactionIndex(), account.GetNativeOperationCount())
}
