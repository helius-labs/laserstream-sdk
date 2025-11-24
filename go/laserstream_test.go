package laserstream

import (
	"fmt"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
	pb "github.com/rpcpool/yellowstone-grpc/examples/golang/proto"
	gproto "google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/testing/protocmp"
)

var cmpOpts = []cmp.Option{
	protocmp.Transform(),
	cmpopts.EquateEmpty(),
}

func boolPtr(v bool) *bool { return &v }

func commitmentPtr(c CommitmentLevel) *CommitmentLevel { return &c }

func slotFilter(commit, interslot bool) *SubscribeRequestFilterSlots {
	return &SubscribeRequestFilterSlots{
		FilterByCommitment: boolPtr(commit),
		InterslotUpdates:   boolPtr(interslot),
	}
}

func accountFilter(tag string) *SubscribeRequestFilterAccounts {
	return &SubscribeRequestFilterAccounts{
		Account:              []string{"acct-" + tag},
		Owner:                []string{"owner-" + tag},
		NonemptyTxnSignature: boolPtr(len(tag)%2 == 0),
	}
}

func txnFilter(tag string) *SubscribeRequestFilterTransactions {
	return &SubscribeRequestFilterTransactions{
		Vote:            boolPtr(len(tag)%2 == 0),
		Failed:          boolPtr(len(tag)%2 == 1),
		Signature:       gproto.String("sig-" + tag),
		AccountInclude:  []string{"inc-" + tag},
		AccountExclude:  []string{"exc-" + tag},
		AccountRequired: []string{"req-" + tag},
	}
}

func blockFilter(tag string) *SubscribeRequestFilterBlocks {
	return &SubscribeRequestFilterBlocks{
		AccountInclude:      []string{"block-" + tag},
		IncludeTransactions: boolPtr(true),
		IncludeAccounts:     boolPtr(false),
		IncludeEntries:      boolPtr(len(tag)%2 == 0),
	}
}

func dataSlice(offset, length uint64) *SubscribeRequestAccountsDataSlice {
	return &SubscribeRequestAccountsDataSlice{Offset: offset, Length: length}
}

func cloneReq(req *SubscribeRequest) *SubscribeRequest {
	if req == nil {
		return nil
	}
	msg := gproto.Clone((*pb.SubscribeRequest)(req))
	return (*SubscribeRequest)(msg.(*pb.SubscribeRequest))
}

func TestMergeSubscribeRequests(t *testing.T) {
	t.Run("nil base is safe", func(t *testing.T) {
		update := &SubscribeRequest{Accounts: map[string]*SubscribeRequestFilterAccounts{"a": accountFilter("1")}}
		mergeSubscribeRequests(nil, update, "internal")
	})

	t.Run("nil update is safe", func(t *testing.T) {
		base := &SubscribeRequest{Accounts: map[string]*SubscribeRequestFilterAccounts{"a": accountFilter("1")}}
		original := cloneReq(base)
		mergeSubscribeRequests(base, nil, "internal")
		if diff := cmp.Diff(original, base, cmpOpts...); diff != "" {
			t.Fatalf("base changed unexpectedly (-want +got):\n%s", diff)
		}
	})

	t.Run("empty update no-op", func(t *testing.T) {
		base := &SubscribeRequest{
			Accounts:   map[string]*SubscribeRequestFilterAccounts{"a": accountFilter("base")},
			Commitment: commitmentPtr(CommitmentLevel_PROCESSED),
			FromSlot:   gproto.Uint64(10),
		}
		original := cloneReq(base)

		mergeSubscribeRequests(base, &SubscribeRequest{}, "internal")
		if diff := cmp.Diff(original, base, cmpOpts...); diff != "" {
			t.Fatalf("expected no change (-want +got):\n%s", diff)
		}
	})

	t.Run("accounts additive and override", func(t *testing.T) {
		base := &SubscribeRequest{Accounts: map[string]*SubscribeRequestFilterAccounts{"a": accountFilter("base")}}
		update := &SubscribeRequest{Accounts: map[string]*SubscribeRequestFilterAccounts{"a": accountFilter("new"), "b": accountFilter("extra")}}
		expected := &SubscribeRequest{Accounts: map[string]*SubscribeRequestFilterAccounts{"a": accountFilter("new"), "b": accountFilter("extra")}}

		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(expected, base, cmpOpts...); diff != "" {
			t.Fatalf("accounts not merged (-want +got):\n%s", diff)
		}
	})

	t.Run("slots additive and preserve internal", func(t *testing.T) {
		internal := "slot-internal"
		base := &SubscribeRequest{Slots: map[string]*SubscribeRequestFilterSlots{
			internal: slotFilter(true, false),
			"keep":   slotFilter(false, false),
		}}
		update := &SubscribeRequest{Slots: map[string]*SubscribeRequestFilterSlots{
			"new": slotFilter(false, true),
		}}

		expected := cloneReq(base)
		expected.Slots["new"] = slotFilter(false, true)

		mergeSubscribeRequests(base, update, internal)
		if diff := cmp.Diff(expected, base, cmpOpts...); diff != "" {
			t.Fatalf("slots not merged (-want +got):\n%s", diff)
		}
	})

	t.Run("internal slot preserved when overwritten", func(t *testing.T) {
		internal := "slot-internal"
		orig := slotFilter(true, false)
		base := &SubscribeRequest{Slots: map[string]*SubscribeRequestFilterSlots{
			internal: orig,
		}}
		update := &SubscribeRequest{Slots: map[string]*SubscribeRequestFilterSlots{
			internal: slotFilter(false, true),
			"other":  slotFilter(false, false),
		}}

		mergeSubscribeRequests(base, update, internal)
		if diff := cmp.Diff(orig, base.Slots[internal], cmpOpts...); diff != "" {
			t.Fatalf("internal slot changed (-want +got):\n%s", diff)
		}
		if base.Slots["other"] == nil {
			t.Fatalf("expected additional slot from update")
		}
	})

	t.Run("internal slot not preserved when id empty", func(t *testing.T) {
		base := &SubscribeRequest{Slots: map[string]*SubscribeRequestFilterSlots{
			"internal": slotFilter(true, false),
		}}
		update := &SubscribeRequest{Slots: map[string]*SubscribeRequestFilterSlots{
			"internal": slotFilter(false, true),
		}}

		mergeSubscribeRequests(base, update, "")
		if diff := cmp.Diff(update.Slots["internal"], base.Slots["internal"], cmpOpts...); diff != "" {
			t.Fatalf("expected update to win when id empty (-want +got):\n%s", diff)
		}
	})

	t.Run("slots map created when nil", func(t *testing.T) {
		base := &SubscribeRequest{}
		update := &SubscribeRequest{Slots: map[string]*SubscribeRequestFilterSlots{"a": slotFilter(true, true)}}

		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(update.Slots, base.Slots, cmpOpts...); diff != "" {
			t.Fatalf("slots not merged (-want +got):\n%s", diff)
		}
	})

	t.Run("transactions additive", func(t *testing.T) {
		base := &SubscribeRequest{Transactions: map[string]*SubscribeRequestFilterTransactions{"a": txnFilter("base")}}
		update := &SubscribeRequest{Transactions: map[string]*SubscribeRequestFilterTransactions{"b": txnFilter("new")}}
		expected := &SubscribeRequest{Transactions: map[string]*SubscribeRequestFilterTransactions{"a": txnFilter("base"), "b": txnFilter("new")}}

		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(expected, base, cmpOpts...); diff != "" {
			t.Fatalf("transactions not merged (-want +got):\n%s", diff)
		}
	})

	t.Run("transactions status additive", func(t *testing.T) {
		base := &SubscribeRequest{TransactionsStatus: map[string]*SubscribeRequestFilterTransactions{"a": txnFilter("base")}}
		update := &SubscribeRequest{TransactionsStatus: map[string]*SubscribeRequestFilterTransactions{"a": txnFilter("new"), "b": txnFilter("extra")}}
		expected := &SubscribeRequest{TransactionsStatus: map[string]*SubscribeRequestFilterTransactions{"a": txnFilter("new"), "b": txnFilter("extra")}}

		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(expected, base, cmpOpts...); diff != "" {
			t.Fatalf("transactions status not merged (-want +got):\n%s", diff)
		}
	})

	t.Run("blocks additive", func(t *testing.T) {
		base := &SubscribeRequest{Blocks: map[string]*SubscribeRequestFilterBlocks{"a": blockFilter("base")}}
		update := &SubscribeRequest{Blocks: map[string]*SubscribeRequestFilterBlocks{"b": blockFilter("new")}}
		expected := &SubscribeRequest{Blocks: map[string]*SubscribeRequestFilterBlocks{"a": blockFilter("base"), "b": blockFilter("new")}}

		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(expected, base, cmpOpts...); diff != "" {
			t.Fatalf("blocks not merged (-want +got):\n%s", diff)
		}
	})

	t.Run("blocks meta additive", func(t *testing.T) {
		base := &SubscribeRequest{BlocksMeta: map[string]*SubscribeRequestFilterBlocksMeta{"a": {}}}
		update := &SubscribeRequest{BlocksMeta: map[string]*SubscribeRequestFilterBlocksMeta{"b": {}}}
		expected := &SubscribeRequest{BlocksMeta: map[string]*SubscribeRequestFilterBlocksMeta{"a": {}, "b": {}}}

		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(expected, base, cmpOpts...); diff != "" {
			t.Fatalf("blocks meta not merged (-want +got):\n%s", diff)
		}
	})

	t.Run("entry additive", func(t *testing.T) {
		base := &SubscribeRequest{Entry: map[string]*SubscribeRequestFilterEntry{"a": {}}}
		update := &SubscribeRequest{Entry: map[string]*SubscribeRequestFilterEntry{"b": {}}}
		expected := &SubscribeRequest{Entry: map[string]*SubscribeRequestFilterEntry{"a": {}, "b": {}}}

		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(expected, base, cmpOpts...); diff != "" {
			t.Fatalf("entry not merged (-want +got):\n%s", diff)
		}
	})

	t.Run("accounts data slice appended", func(t *testing.T) {
		base := &SubscribeRequest{AccountsDataSlice: []*SubscribeRequestAccountsDataSlice{dataSlice(1, 2)}}
		update := &SubscribeRequest{AccountsDataSlice: []*SubscribeRequestAccountsDataSlice{dataSlice(3, 4), dataSlice(5, 6)}}
		expected := &SubscribeRequest{AccountsDataSlice: []*SubscribeRequestAccountsDataSlice{dataSlice(1, 2), dataSlice(3, 4), dataSlice(5, 6)}}

		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(expected, base, cmpOpts...); diff != "" {
			t.Fatalf("accounts data slice not appended (-want +got):\n%s", diff)
		}
	})

	t.Run("commitment override none to some", func(t *testing.T) {
		base := &SubscribeRequest{}
		update := &SubscribeRequest{Commitment: commitmentPtr(CommitmentLevel_CONFIRMED)}

		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(update.Commitment, base.Commitment, cmpOpts...); diff != "" {
			t.Fatalf("commitment not overridden (-want +got):\n%s", diff)
		}
	})

	t.Run("commitment override some to some", func(t *testing.T) {
		base := &SubscribeRequest{Commitment: commitmentPtr(CommitmentLevel_PROCESSED)}
		update := &SubscribeRequest{Commitment: commitmentPtr(CommitmentLevel_FINALIZED)}

		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(update.Commitment, base.Commitment, cmpOpts...); diff != "" {
			t.Fatalf("commitment not replaced (-want +got):\n%s", diff)
		}
	})

	t.Run("commitment unchanged when absent", func(t *testing.T) {
		base := &SubscribeRequest{Commitment: commitmentPtr(CommitmentLevel_FINALIZED)}
		update := &SubscribeRequest{}
		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(commitmentPtr(CommitmentLevel_FINALIZED), base.Commitment, cmpOpts...); diff != "" {
			t.Fatalf("commitment unexpectedly changed (-want +got):\n%s", diff)
		}
	})

	t.Run("from slot override none to some", func(t *testing.T) {
		base := &SubscribeRequest{}
		update := &SubscribeRequest{FromSlot: gproto.Uint64(42)}

		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(update.FromSlot, base.FromSlot, cmpOpts...); diff != "" {
			t.Fatalf("from_slot not overridden (-want +got):\n%s", diff)
		}
	})

	t.Run("from slot override some to some", func(t *testing.T) {
		base := &SubscribeRequest{FromSlot: gproto.Uint64(7)}
		update := &SubscribeRequest{FromSlot: gproto.Uint64(99)}

		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(update.FromSlot, base.FromSlot, cmpOpts...); diff != "" {
			t.Fatalf("from_slot not replaced (-want +got):\n%s", diff)
		}
	})

	t.Run("from slot unchanged when absent", func(t *testing.T) {
		base := &SubscribeRequest{FromSlot: gproto.Uint64(15)}
		update := &SubscribeRequest{}
		mergeSubscribeRequests(base, update, "internal")
		if diff := cmp.Diff(gproto.Uint64(15), base.FromSlot, cmpOpts...); diff != "" {
			t.Fatalf("from_slot unexpectedly changed (-want +got):\n%s", diff)
		}
	})

	t.Run("large map merge with internal preserved", func(t *testing.T) {
		internal := "slot-internal"
		base := &SubscribeRequest{Slots: map[string]*SubscribeRequestFilterSlots{internal: slotFilter(true, false)}}
		for i := 0; i < 120; i++ {
			key := fmt.Sprintf("slot-base-%d", i)
			base.Slots[key] = slotFilter(i%2 == 0, i%3 == 0)
		}
		update := &SubscribeRequest{Slots: map[string]*SubscribeRequestFilterSlots{}}
		for i := 50; i < 170; i++ {
			key := fmt.Sprintf("slot-upd-%d", i)
			update.Slots[key] = slotFilter(i%2 == 1, i%3 == 1)
		}
		update.Slots[internal] = slotFilter(false, true)

		mergeSubscribeRequests(base, update, internal)
		if base.Slots[internal].GetFilterByCommitment() != true {
			t.Fatalf("internal slot not preserved")
		}
		if got := len(base.Slots); got != 1+120+120 { // internal + originals + updates
			t.Fatalf("unexpected slot count: %d", got)
		}
	})

	t.Run("base only internal slot survives conflicting update", func(t *testing.T) {
		internal := "slot-internal"
		base := &SubscribeRequest{Slots: map[string]*SubscribeRequestFilterSlots{internal: slotFilter(true, false)}}
		update := &SubscribeRequest{Slots: map[string]*SubscribeRequestFilterSlots{internal: slotFilter(false, true)}}

		mergeSubscribeRequests(base, update, internal)
		if diff := cmp.Diff(slotFilter(true, false), base.Slots[internal], cmpOpts...); diff != "" {
			t.Fatalf("internal slot lost (-want +got):\n%s", diff)
		}
	})

	t.Run("mixed fields merge together", func(t *testing.T) {
		internal := "slot-internal"
		base := &SubscribeRequest{
			Accounts: map[string]*SubscribeRequestFilterAccounts{"a": accountFilter("base")},
			Slots:    map[string]*SubscribeRequestFilterSlots{internal: slotFilter(true, false)},
			Blocks:   map[string]*SubscribeRequestFilterBlocks{"b": blockFilter("base")},
		}
		update := &SubscribeRequest{
			Accounts: map[string]*SubscribeRequestFilterAccounts{"c": accountFilter("new")},
			Slots:    map[string]*SubscribeRequestFilterSlots{"user": slotFilter(false, true)},
			Blocks:   map[string]*SubscribeRequestFilterBlocks{"b": blockFilter("new")},
		}
		expected := &SubscribeRequest{
			Accounts: map[string]*SubscribeRequestFilterAccounts{"a": accountFilter("base"), "c": accountFilter("new")},
			Slots:    map[string]*SubscribeRequestFilterSlots{internal: slotFilter(true, false), "user": slotFilter(false, true)},
			Blocks:   map[string]*SubscribeRequestFilterBlocks{"b": blockFilter("new")},
		}

		mergeSubscribeRequests(base, update, internal)
		if diff := cmp.Diff(expected, base, cmpOpts...); diff != "" {
			t.Fatalf("mixed merge failed (-want +got):\n%s", diff)
		}
	})
}