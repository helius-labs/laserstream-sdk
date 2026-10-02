package laserstream

import (
	"bytes"
	"testing"

	"google.golang.org/protobuf/proto"
)

func TestUpdateParentProtoRoundTrip(t *testing.T) {
	includeUpdateParent := true
	filter := &SubscribeRequestFilterEntry{IncludeUpdateParent: &includeUpdateParent}
	filterWire, err := proto.Marshal(filter)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(filterWire, []byte{0x08, 0x01}) {
		t.Fatalf("include_update_parent wire = %x, want 0801", filterWire)
	}

	parentBlockID := bytes.Repeat([]byte{0xab}, 32)
	update := &SubscribeUpdate{
		UpdateOneof: &SubscribeUpdate_EntryUpdateParent{
			EntryUpdateParent: &SubscribeUpdateEntryUpdateParent{
				Slot:          42,
				ClearedBankId: 7,
				ParentSlot:    41,
				ParentBlockId: parentBlockID,
			},
		},
	}
	wire, err := proto.Marshal(update)
	if err != nil {
		t.Fatal(err)
	}
	if len(wire) < 2 || wire[0] != 0x6a { // field 13, length-delimited
		t.Fatalf("entry_update_parent wire prefix = %x, want field 13", wire)
	}

	decoded := new(SubscribeUpdate)
	if err := proto.Unmarshal(wire, decoded); err != nil {
		t.Fatal(err)
	}
	got := decoded.GetEntryUpdateParent()
	if got == nil || got.Slot != 42 || got.ClearedBankId != 7 || got.ParentSlot != 41 || !bytes.Equal(got.ParentBlockId, parentBlockID) {
		t.Fatalf("entry_update_parent round trip = %+v", got)
	}
}
