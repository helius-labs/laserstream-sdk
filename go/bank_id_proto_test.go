package laserstream

import (
	"testing"

	"google.golang.org/protobuf/proto"
)

func TestSubscribeUpdateBankIDRoundTrip(t *testing.T) {
	tests := []struct {
		name   string
		update *SubscribeUpdate
		read   func(*SubscribeUpdate) uint64
	}{
		{
			name: "account",
			update: &SubscribeUpdate{
				UpdateOneof: &SubscribeUpdate_Account{
					Account: &SubscribeUpdateAccount{
						Slot:   42,
						BankId: proto.Uint64(7),
					},
				},
			},
			read: func(update *SubscribeUpdate) uint64 {
				return update.GetAccount().GetBankId()
			},
		},
		{
			name: "slot",
			update: &SubscribeUpdate{
				UpdateOneof: &SubscribeUpdate_Slot{
					Slot: &SubscribeUpdateSlot{
						Slot:   42,
						BankId: proto.Uint64(7),
					},
				},
			},
			read: func(update *SubscribeUpdate) uint64 {
				return update.GetSlot().GetBankId()
			},
		},
		{
			name: "transaction",
			update: &SubscribeUpdate{
				UpdateOneof: &SubscribeUpdate_Transaction{
					Transaction: &SubscribeUpdateTransaction{
						Slot:   42,
						BankId: 7,
					},
				},
			},
			read: func(update *SubscribeUpdate) uint64 {
				return update.GetTransaction().GetBankId()
			},
		},
		{
			name: "transaction_status",
			update: &SubscribeUpdate{
				UpdateOneof: &SubscribeUpdate_TransactionStatus{
					TransactionStatus: &SubscribeUpdateTransactionStatus{
						Slot:   42,
						BankId: 7,
					},
				},
			},
			read: func(update *SubscribeUpdate) uint64 {
				return update.GetTransactionStatus().GetBankId()
			},
		},
		{
			name: "block",
			update: &SubscribeUpdate{
				UpdateOneof: &SubscribeUpdate_Block{
					Block: &SubscribeUpdateBlock{
						Slot:   42,
						BankId: 7,
					},
				},
			},
			read: func(update *SubscribeUpdate) uint64 {
				return update.GetBlock().GetBankId()
			},
		},
		{
			name: "block_meta",
			update: &SubscribeUpdate{
				UpdateOneof: &SubscribeUpdate_BlockMeta{
					BlockMeta: &SubscribeUpdateBlockMeta{
						Slot:   42,
						BankId: 7,
					},
				},
			},
			read: func(update *SubscribeUpdate) uint64 {
				return update.GetBlockMeta().GetBankId()
			},
		},
		{
			name: "entry",
			update: &SubscribeUpdate{
				UpdateOneof: &SubscribeUpdate_Entry{
					Entry: &SubscribeUpdateEntry{
						Slot:   42,
						BankId: 7,
					},
				},
			},
			read: func(update *SubscribeUpdate) uint64 {
				return update.GetEntry().GetBankId()
			},
		},
		{
			name: "block_footer",
			update: &SubscribeUpdate{
				UpdateOneof: &SubscribeUpdate_BlockFooter{
					BlockFooter: &SubscribeUpdateBlockFooter{
						Slot:   42,
						BankId: 7,
					},
				},
			},
			read: func(update *SubscribeUpdate) uint64 {
				return update.GetBlockFooter().GetBankId()
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bytes, err := proto.Marshal(tt.update)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			var decoded SubscribeUpdate
			if err := proto.Unmarshal(bytes, &decoded); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}

			if got := tt.read(&decoded); got != 7 {
				t.Fatalf("bank_id = %d, want 7", got)
			}
		})
	}
}
