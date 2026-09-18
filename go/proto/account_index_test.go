package proto

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/dynamicpb"
)

func TestAccountTransactionIndex(t *testing.T) {
	// Historical descriptor: remove only field 32, retaining all old fields.
	fd := protodesc.ToFileDescriptorProto(File_geyser_proto)
	for _, msg := range fd.MessageType {
		if msg.GetName() == "SubscribeUpdateAccountInfo" {
			fields := msg.Field[:0]
			for _, field := range msg.Field {
				if field.GetNumber() != 32 {
					fields = append(fields, field)
				}
			}
			msg.Field = fields
		}
	}
	oldFile, err := protodesc.NewFile(fd, protoregistry.GlobalFiles)
	if err != nil {
		t.Fatal(err)
	}
	oldFields, _ := hex.DecodeString("0a010110071a0102200128083201033809420104")
	for _, tc := range []struct {
		wire  string
		value uint64
	}{
		{"", 0}, {"800200", 0}, {"80022a", 42},
		{"8002ffffffffffffffffff01", ^uint64(0)},
		{"8002feffffffffffffffff01", ^uint64(0) - 1},
	} {
		suffix, err := hex.DecodeString(tc.wire)
		if err != nil {
			t.Fatal(err)
		}
		info := append(append([]byte{}, oldFields...), suffix...)
		for _, block := range []bool{false, true} {
			innerTag, outerTag := byte(0x0a), byte(0x12)
			if block {
				innerTag, outerTag = 0x5a, 0x2a
			}
			nested := append([]byte{innerTag, byte(len(info))}, info...)
			wire := append([]byte{outerTag, byte(len(nested))}, nested...)
			var update SubscribeUpdate
			if err := proto.Unmarshal(wire, &update); err != nil {
				t.Fatal(err)
			}
			var account *SubscribeUpdateAccountInfo
			if block {
				account = update.GetBlock().Accounts[0]
			} else {
				account = update.GetAccount().Account
			}
			want := DecodeAccountTransactionIndex(tc.value)
			if account.AccountTransactionIndex() != want {
				t.Fatalf("typed mismatch: %v", account)
			}
			if err := account.SetAccountTransactionIndex(want); err != nil {
				t.Fatal(err)
			}
			if account.TransactionIndex != tc.value {
				t.Fatal("shifted scalar")
			}
			if err := account.SetAccountTransactionIndex(AccountTransactionIndex{Kind: TransactionWrite, Index: ^uint64(0)}); err == nil {
				t.Fatal("reserved transaction accepted")
			}
			if account.TransactionIndex != tc.value {
				t.Fatal("failed setter mutated account")
			}
			encoded, err := proto.Marshal(&update)
			if err != nil {
				t.Fatal(err)
			}
			var replay SubscribeUpdate
			if err := proto.Unmarshal(encoded, &replay); err != nil {
				t.Fatal(err)
			}
			if !proto.Equal(&update, &replay) {
				t.Fatal("protobuf roundtrip changed data")
			}
			jsonWire, err := protojson.Marshal(&update)
			if err != nil {
				t.Fatal(err)
			}
			if err := protojson.Unmarshal(jsonWire, &replay); err != nil {
				t.Fatal(err)
			}
			if !proto.Equal(&update, &replay) {
				t.Fatal("protobuf JSON roundtrip changed data")
			}
			jsonTyped, _ := json.Marshal(want)
			var typed AccountTransactionIndex
			if err := json.Unmarshal(jsonTyped, &typed); err != nil {
				t.Fatal(err)
			}
			if typed != want {
				t.Fatal("typed JSON roundtrip changed data")
			}
			// A real old-schema protobuf decoder reads direct and block updates unchanged.
			legacy := dynamicpb.NewMessage(oldFile.Messages().ByName("SubscribeUpdate"))
			if err := proto.Unmarshal(encoded, legacy); err != nil {
				t.Fatal(err)
			}
			var oldAccount *dynamicpb.Message
			if block {
				b := legacy.Get(legacy.Descriptor().Fields().ByName("block")).Message()
				oldAccount = b.Get(b.Descriptor().Fields().ByName("accounts")).List().Get(0).Message().Interface().(*dynamicpb.Message)
			} else {
				a := legacy.Get(legacy.Descriptor().Fields().ByName("account")).Message()
				oldAccount = a.Get(a.Descriptor().Fields().ByName("account")).Message().Interface().(*dynamicpb.Message)
			}
			oldAccount.SetUnknown(nil)
			oldEncoded, err := (proto.MarshalOptions{Deterministic: true}).Marshal(oldAccount)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(oldEncoded, oldFields) {
				t.Fatalf("old fields changed: %x", oldEncoded)
			}
		}
	}
	for _, invalid := range []AccountTransactionIndex{
		{Kind: TransactionWrite, Index: ^uint64(0)}, {Kind: 99}, {Kind: NoTransaction, Index: 1},
	} {
		if _, err := invalid.ToWire(); err == nil {
			t.Fatalf("accepted invalid value %v", invalid)
		}
	}
}
