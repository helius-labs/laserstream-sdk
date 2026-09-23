package laserstream

import "testing"

func TestMergeSubscribeRequestPreservesInternalSlotTrackerAndReplacesFooterFilters(t *testing.T) {
	client := &Client{
		originalRequest: &SubscribeRequest{
			Slots: map[string]*SubscribeRequestFilterSlots{
				"__internal_slot_tracker_test": {FilterByCommitment: boolPtr(true)},
			},
			BlockFooter: map[string]*SubscribeRequestFilterBlockFooter{
				"old": {},
			},
		},
	}

	client.mergeSubscribeRequest(&SubscribeRequest{
		BlockFooter: map[string]*SubscribeRequestFilterBlockFooter{
			"new": {},
		},
	})

	if _, ok := client.originalRequest.Slots["__internal_slot_tracker_test"]; !ok {
		t.Fatalf("internal slot tracker was dropped")
	}
	if _, ok := client.originalRequest.BlockFooter["new"]; !ok {
		t.Fatalf("new footer filter missing after replacement")
	}
	if _, ok := client.originalRequest.BlockFooter["old"]; ok {
		t.Fatalf("old footer filter should have been replaced")
	}
}

func TestFooterDedupClearAllowsReplacementReplay(t *testing.T) {
	dedup := newFooterDedup()
	if !dedup.shouldForward(42, 7) {
		t.Fatalf("first footer should pass")
	}
	dedup.clear()
	if !dedup.shouldForward(42, 7) {
		t.Fatalf("cleared dedup should allow the same footer again")
	}
}

func TestFooterDedupConcurrentFilterReplacement(t *testing.T) {
	dedup := newFooterDedup()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 1000; i++ {
			dedup.clear()
		}
	}()
	for i := 0; i < 1000; i++ {
		dedup.shouldForward(uint64(i), 7)
	}
	<-done
}

func boolPtr(v bool) *bool { return &v }
