package laserstream

import (
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
)

// Driven by ../test/replay-transport.js, including unmodified captured producer bytes.
func TestReplayTransportConsumer(t *testing.T) {
	endpoint := os.Getenv("SDK_REPLAY_ENDPOINT")
	if endpoint == "" {
		t.Skip("requires cross-language replay transport harness")
	}
	if !strings.HasPrefix(endpoint, "http://127.0.0.1:") {
		t.Fatal("loopback only")
	}
	var from *uint64
	if value := os.Getenv("SDK_REPLAY_FROM_SLOT"); value != "" {
		slot, err := strconv.ParseUint(value, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		from = &slot
	}
	replay := os.Getenv("SDK_REPLAY_ENABLED") == "true"
	attempts := 10
	c := NewClient(LaserstreamConfig{Endpoint: endpoint, Replay: &replay, MaxReconnectAttempts: &attempts})
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	done := make(chan struct{}, 1)
	failures := make(chan error, 10)
	err := c.SubscribeWithContext(ctx, &SubscribeRequest{FromSlot: from}, func(update *SubscribeUpdate) {
		if len(update.Filters) == 1 && update.Filters[0] == "__sdk_test_done" {
			done <- struct{}{}
			return
		}
		data, err := proto.Marshal(update)
		if err != nil {
			failures <- err
			return
		}
		fmt.Printf("SDK_UPDATE {\"hex\":\"%s\"}\n", hex.EncodeToString(data))
	}, func(err error) { failures <- err })
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case err := <-failures:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
