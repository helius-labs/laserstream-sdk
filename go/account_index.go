package laserstream

import pb "github.com/helius-labs/laserstream-sdk/go/proto"

// AccountIndex is the typed account/block-account index view.
type AccountIndex = pb.AccountIndex
type AccountIndexKind = pb.AccountIndexKind

const (
	TransactionIndex = pb.TransactionIndex
	NativeOperation  = pb.NativeOperation
)
