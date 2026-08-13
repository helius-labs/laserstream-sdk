package laserstream

// Regression vectors for V1 transaction config (SIMD-0385) and
// Reward.commission_bps (SIMD-0291).
//
// The base64 payloads are SubscribeUpdate messages encoded with
// laserstream-core-proto 11.2.0 (Rust/prost) — the same bytes are asserted
// against the JS and Rust SDKs, so all three decode identically.

import (
	"encoding/base64"
	"testing"

	pb "github.com/helius-labs/laserstream-sdk/go/proto"
	"google.golang.org/protobuf/proto"
)

// SubscribeUpdate{transaction} whose message carries TransactionConfig
const v1ConfigTxB64 = "CgR2ZWMxIpUCCowCCkAHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHGsMBCkAHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHEn8KBAgBGAISIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBEiACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAhogCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkoAToPCJS05PTLAxDAuVUggIAQIgAoKhC72ZGsAQ=="

// SubscribeUpdate{block} whose rewards carry commission_bps
const commissionBpsBlockB64 = "CgR2ZWMyKoYBCLzZkawBEgR0ZXN0GngKPgorVm90ZTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMRCIJxigjQYgBCoBNTIDNTUwCjYKK1N0YWtlMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTEQj04YwJoMIAM="

func mustDecode(t *testing.T, b64 string) *pb.SubscribeUpdate {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("bad base64: %v", err)
	}
	var update pb.SubscribeUpdate
	if err := proto.Unmarshal(raw, &update); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return &update
}

func TestV1TransactionConfigDecodes(t *testing.T) {
	update := mustDecode(t, v1ConfigTxB64)

	tx := update.GetTransaction()
	if tx == nil {
		t.Fatal("expected transaction update")
	}
	if tx.GetSlot() != 361000123 {
		t.Fatalf("slot = %d, want 361000123", tx.GetSlot())
	}

	msg := tx.GetTransaction().GetTransaction().GetMessage()
	if !msg.GetVersioned() {
		t.Fatal("expected versioned = true")
	}
	cfg := msg.GetConfig()
	if cfg == nil {
		t.Fatal("expected message.config to be present for V1")
	}
	if got := cfg.GetPriorityFee(); got != 123456789012 {
		t.Fatalf("priority_fee = %d, want 123456789012", got)
	}
	if got := cfg.GetComputeUnitLimit(); got != 1400000 {
		t.Fatalf("compute_unit_limit = %d, want 1400000", got)
	}
	if got := cfg.GetHeapSize(); got != 262144 {
		t.Fatalf("heap_size = %d, want 262144", got)
	}
	if cfg.LoadedAccountsDataSizeLimit != nil {
		t.Fatal("loaded_accounts_data_size_limit must be absent")
	}
}

func TestRewardCommissionBpsDecodes(t *testing.T) {
	update := mustDecode(t, commissionBpsBlockB64)

	block := update.GetBlock()
	if block == nil {
		t.Fatal("expected block update")
	}
	rewards := block.GetRewards().GetRewards()
	if len(rewards) != 2 {
		t.Fatalf("rewards = %d, want 2", len(rewards))
	}

	if got := rewards[0].GetCommissionBps(); got != "550" {
		t.Fatalf("commission_bps = %q, want \"550\"", got)
	}
	if got := rewards[0].GetCommission(); got != "5" {
		t.Fatalf("commission = %q, want \"5\"", got)
	}
	if rewards[0].GetRewardType() != pb.RewardType_Voting {
		t.Fatalf("reward_type = %v, want Voting", rewards[0].GetRewardType())
	}

	// Reward without commission: empty string on the wire
	if got := rewards[1].GetCommissionBps(); got != "" {
		t.Fatalf("commission_bps = %q, want empty", got)
	}
}
