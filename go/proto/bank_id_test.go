package proto

import (
	"google.golang.org/protobuf/proto"
	"testing"
)

func TestBankIDTritonWireVectors(t *testing.T) {
	cases := []struct {
		message  proto.Message
		tag      byte
		optional bool
	}{
		{&SubscribeUpdateAccount{}, 4, true}, {&SubscribeUpdateSlot{}, 5, true},
		{&SubscribeUpdateTransaction{}, 3, false}, {&SubscribeUpdateTransactionStatus{}, 6, false},
		{&SubscribeUpdateBlock{}, 14, false}, {&SubscribeUpdateBlockMeta{}, 10, false}, {&SubscribeUpdateEntry{}, 7, false},
	}
	values := [][]byte{nil, {0}, {1}, {255, 255, 255, 255, 255, 255, 255, 255, 255, 1}}
	for _, c := range cases {
		for i, value := range values {
			var wire []byte
			if value != nil {
				wire = append([]byte{c.tag << 3}, value...)
			}
			message := proto.Clone(c.message)
			if err := proto.Unmarshal(wire, message); err != nil {
				t.Fatal(err)
			}
			m := message.ProtoReflect()
			field := m.Descriptor().Fields().ByName("bank_id")
			expected := []uint64{0, 0, 1, ^uint64(0)}[i]
			if m.Get(field).Uint() != expected {
				t.Fatalf("%T bank ID", message)
			}
			if c.optional && m.Has(field) != (value != nil) {
				t.Fatalf("%T presence", message)
			}
			if int(field.Number()) != int(c.tag) || field.HasPresence() != c.optional {
				t.Fatalf("%T descriptor", message)
			}
		}
	}
}
