package laserstream

import (
	"bytes"
	"crypto/sha256"
	"sort"

	pb "github.com/helius-labs/laserstream-sdk/go/proto"
	"google.golang.org/protobuf/proto"
)

// Kept across connections, scoped to a subscription and its replay window.
type replayDedup struct {
	newestSlot uint64
	seen       map[uint64]map[[32]byte]*replayOccurrences
}

type replayOccurrences struct {
	delivered uint64
	observed  uint64
}

func (d *replayDedup) beginConnection() {
	for _, updates := range d.seen {
		for _, count := range updates {
			count.observed = 0
		}
	}
}

func updateSlot(update *pb.SubscribeUpdate) (uint64, bool) {
	switch v := update.UpdateOneof.(type) {
	case *pb.SubscribeUpdate_Account:
		return v.Account.Slot, v.Account.BankId != nil
	case *pb.SubscribeUpdate_Slot:
		return v.Slot.Slot, v.Slot.BankId != nil
	case *pb.SubscribeUpdate_Transaction:
		return v.Transaction.Slot, v.Transaction.BankId != 0
	case *pb.SubscribeUpdate_TransactionStatus:
		return v.TransactionStatus.Slot, v.TransactionStatus.BankId != 0
	case *pb.SubscribeUpdate_Block:
		return v.Block.Slot, v.Block.BankId != 0
	case *pb.SubscribeUpdate_BlockMeta:
		return v.BlockMeta.Slot, v.BlockMeta.BankId != 0
	case *pb.SubscribeUpdate_Entry:
		return v.Entry.Slot, v.Entry.BankId != 0
	default:
		return 0, false
	}
}

func (d *replayDedup) duplicate(update *pb.SubscribeUpdate) bool {
	slot, identified := updateSlot(update)
	if slot > d.newestSlot {
		d.newestSlot = slot
	}
	oldest := uint64(0)
	if d.newestSlot > ForkDepthSafetyMargin {
		oldest = d.newestSlot - ForkDepthSafetyMargin
	}
	for retained := range d.seen {
		if retained < oldest {
			delete(d.seen, retained)
		}
	}
	// Scalar omission aliases zero; don't invent a bank identity for legacy data.
	if !identified || slot < oldest {
		return false
	}
	filters := append([]string(nil), update.Filters...)
	sort.Strings(filters)
	// Retain canonical indices, pubkeys, bank and semantic content; exclude
	// worker-local write versions and timestamps without changing user payloads.
	identity := &pb.SubscribeUpdate{Filters: filters, UpdateOneof: update.UpdateOneof}
	switch v := update.UpdateOneof.(type) {
	case *pb.SubscribeUpdate_Account:
		// Native replay stays pass-through: worker ingest dedup is separate,
		// and a mid-bank subscriber has no transaction-owned write position.
		if v.Account.Account == nil || len(v.Account.Account.TxnSignature) == 0 {
			return false
		}
		account := proto.Clone(v.Account).(*pb.SubscribeUpdateAccount)
		if account.Account != nil {
			account.Account.WriteVersion = 0
		}
		identity.UpdateOneof = &pb.SubscribeUpdate_Account{Account: account}
	case *pb.SubscribeUpdate_Block:
		block := proto.Clone(v.Block).(*pb.SubscribeUpdateBlock)
		accountKeys := make(map[*pb.SubscribeUpdateAccountInfo][]byte, len(block.Accounts))
		for _, account := range block.Accounts {
			account.WriteVersion = 0
			encoded, err := (proto.MarshalOptions{Deterministic: true}).Marshal(account)
			if err != nil {
				return false
			}
			accountKeys[account] = encoded
		}
		// Block assembly may follow worker callback order, not ledger order.
		sort.Slice(block.Accounts, func(i, j int) bool {
			return bytes.Compare(accountKeys[block.Accounts[i]], accountKeys[block.Accounts[j]]) < 0
		})
		identity.UpdateOneof = &pb.SubscribeUpdate_Block{Block: block}
	}
	encoded, err := (proto.MarshalOptions{Deterministic: true}).Marshal(identity)
	if err != nil {
		return false
	}
	key := sha256.Sum256(encoded)
	if d.seen == nil {
		d.seen = make(map[uint64]map[[32]byte]*replayOccurrences)
	}
	if d.seen[slot] == nil {
		d.seen[slot] = make(map[[32]byte]*replayOccurrences)
	}
	count := d.seen[slot][key]
	if count == nil {
		count = &replayOccurrences{}
		d.seen[slot][key] = count
	}
	// Preserve repeated notifications within one connection while removing
	// their replay overlap. Native account writes bypass this state.
	count.observed++
	if count.observed <= count.delivered {
		return true
	}
	count.delivered = count.observed
	return false
}
