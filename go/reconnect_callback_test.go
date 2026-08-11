package laserstream

import (
	"context"
	"sync"
	"testing"
	"time"
)

// ReconnectCallback exists because ErrorCallback answers a different question.
// ErrorCallback fires once, after reconnection is abandoned; a stream that
// fails and recovers repeatedly never reaches it, so a caller watching only
// that signal cannot distinguish a healthy stream from one flapping constantly.
//
// These tests use an endpoint that cannot connect, so every attempt fails and
// the loop runs to exhaustion quickly.
func TestReconnectCallbackFiresPerAttemptBeforeErrorCallback(t *testing.T) {
	var (
		mu        sync.Mutex
		attempts  []ReconnectInfo
		fatal     error
		fatalSeen = make(chan struct{})
	)

	maxAttempts := 3
	client := NewClient(LaserstreamConfig{
		// Reserved TEST-NET-1 address: routable syntax, never connectable.
		Endpoint:             "https://192.0.2.1:443",
		APIKey:               "test",
		MaxReconnectAttempts: &maxAttempts,
		ChannelOptions:       &ChannelOptions{ConnectTimeoutSecs: 1, MinConnectTimeoutSecs: 1},
		ReconnectCallback: func(info ReconnectInfo) {
			mu.Lock()
			attempts = append(attempts, info)
			mu.Unlock()
		},
	})
	t.Cleanup(client.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	err := client.SubscribeWithContext(ctx, &SubscribeRequest{}, func(*SubscribeUpdate) {},
		func(e error) {
			mu.Lock()
			fatal = e
			mu.Unlock()
			close(fatalSeen)
		})
	if err != nil {
		t.Fatalf("SubscribeWithContext: %v", err)
	}

	select {
	case <-fatalSeen:
	case <-ctx.Done():
		t.Fatal("stream never reached its terminal error")
	}

	mu.Lock()
	defer mu.Unlock()

	if fatal == nil {
		t.Fatal("ErrorCallback did not fire after attempts were exhausted")
	}
	// The point of the hook: every attempt was observable, not just the last.
	if len(attempts) != maxAttempts {
		t.Fatalf("ReconnectCallback fired %d times, want %d (one per attempt)", len(attempts), maxAttempts)
	}
	for i, info := range attempts {
		if want := uint32(i + 1); info.Attempt != want {
			t.Errorf("attempt %d reported Attempt=%d, want %d", i, info.Attempt, want)
		}
		if info.MaxAttempts != uint32(maxAttempts) {
			t.Errorf("attempt %d reported MaxAttempts=%d, want %d", i, info.MaxAttempts, maxAttempts)
		}
		// Deliberately no error on the struct: the SDK absorbs server-side
		// failures and surfaces one only via ErrorCallback, at the end.
		// Nothing ever connected, so nothing ever recovered.
		if info.RecoveredSincePreviousFailure {
			t.Errorf("attempt %d reported a recovery, but no connection ever succeeded", i)
		}
	}
}

// A nil callback must leave behaviour exactly as it was, so the field is safe
// to add to a released SDK.
func TestNilReconnectCallbackIsInert(t *testing.T) {
	maxAttempts := 2
	client := NewClient(LaserstreamConfig{
		Endpoint:             "https://192.0.2.1:443",
		APIKey:               "test",
		MaxReconnectAttempts: &maxAttempts,
		ChannelOptions:       &ChannelOptions{ConnectTimeoutSecs: 1, MinConnectTimeoutSecs: 1},
		// ReconnectCallback deliberately unset.
	})
	t.Cleanup(client.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	done := make(chan struct{})
	if err := client.SubscribeWithContext(ctx, &SubscribeRequest{}, func(*SubscribeUpdate) {},
		func(error) { close(done) }); err != nil {
		t.Fatalf("SubscribeWithContext: %v", err)
	}

	select {
	case <-done: // reached the terminal error without panicking on the nil hook
	case <-ctx.Done():
		t.Fatal("stream never terminated with a nil ReconnectCallback")
	}
}
