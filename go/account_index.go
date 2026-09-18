package laserstream

import pb "github.com/helius-labs/laserstream-sdk/go/proto"

// AccountTransactionIndex is the typed account/block-account index view.
type AccountTransactionIndex = pb.AccountTransactionIndex
type AccountTransactionIndexKind = pb.AccountTransactionIndexKind

const (
	TransactionWrite = pb.TransactionWrite
	NoTransaction    = pb.NoTransaction
)
