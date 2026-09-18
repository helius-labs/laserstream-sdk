package proto

import "fmt"

// AccountTransactionIndexKind distinguishes transaction writes from native writes.
type AccountTransactionIndexKind uint8

const (
	TransactionWrite AccountTransactionIndexKind = iota
	NoTransaction
)

// AccountTransactionIndex is a typed view of the raw protobuf uint64.
// Index is zero-based and is meaningful only for Kind == TransactionWrite.
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

// ToWire checks the reserved transaction index and invalid tagged values.
func (value AccountTransactionIndex) ToWire() (uint64, error) {
	switch value.Kind {
	case TransactionWrite:
		if value.Index != ^uint64(0) {
			return value.Index, nil
		}
	case NoTransaction:
		if value.Index == 0 {
			return ^uint64(0), nil
		}
	}
	return 0, fmt.Errorf("invalid AccountTransactionIndex: kind=%d index=%d", value.Kind, value.Index)
}

// AccountTransactionIndex returns TransactionWrite(0) for legacy omitted field 32.
func (account *SubscribeUpdateAccountInfo) AccountTransactionIndex() AccountTransactionIndex {
	return DecodeAccountTransactionIndex(account.GetTransactionIndex())
}

func (account *SubscribeUpdateAccountInfo) SetAccountTransactionIndex(value AccountTransactionIndex) error {
	raw, err := value.ToWire()
	if err != nil {
		return err
	}
	account.TransactionIndex = raw
	return nil
}
