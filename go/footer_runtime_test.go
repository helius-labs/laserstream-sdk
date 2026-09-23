package laserstream

import (
	"context"
	"net"
	"sync"
	"testing"
	"time"

	pb "github.com/helius-labs/laserstream-sdk/go/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

type footerRuntimeServer struct {
	pb.UnimplementedGeyserServer

	mu            sync.Mutex
	attempt       int
	initialReqs   []*SubscribeRequest
	writeReqs     []*SubscribeRequest
	writeObserved chan struct{}
	waitForWrite  bool
}

func newFooterRuntimeServer(waitForWrite bool) *footerRuntimeServer {
	return &footerRuntimeServer{
		writeObserved: make(chan struct{}, 1),
		waitForWrite:  waitForWrite,
	}
}

func cloneSubscribeRequest(req *SubscribeRequest) *SubscribeRequest {
	return proto.Clone(req).(*SubscribeRequest)
}

func (s *footerRuntimeServer) Subscribe(stream pb.Geyser_SubscribeServer) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}

	s.mu.Lock()
	s.attempt++
	attempt := s.attempt
	s.initialReqs = append(s.initialReqs, cloneSubscribeRequest(first))
	s.mu.Unlock()

	filterName := "old-footer"
	if attempt > 1 {
		filterName = "new-footer"
	}

	if err := stream.Send(&SubscribeUpdate{
		Filters: []string{filterName},
		UpdateOneof: &pb.SubscribeUpdate_BlockFooter{
			BlockFooter: &pb.SubscribeUpdateBlockFooter{
				Slot:                   42,
				BankId:                 7,
				BankHash:               make([]byte, 32),
				BlockProducerTimeNanos: 123,
				BlockUserAgent:         []byte("agave"),
			},
		},
	}); err != nil {
		return err
	}

	if attempt == 1 && s.waitForWrite {
		writeReq, err := stream.Recv()
		if err != nil {
			return err
		}
		s.mu.Lock()
		s.writeReqs = append(s.writeReqs, cloneSubscribeRequest(writeReq))
		s.mu.Unlock()
		select {
		case s.writeObserved <- struct{}{}:
		default:
		}
	}

	return status.Error(codes.Unavailable, "restart")
}

func startFooterRuntimeServer(t *testing.T, server pb.GeyserServer) (string, func()) {
	t.Helper()

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	grpcServer := grpc.NewServer()
	pb.RegisterGeyserServer(grpcServer, server)

	go func() {
		_ = grpcServer.Serve(lis)
	}()

	return "http://" + lis.Addr().String(), func() {
		grpcServer.Stop()
		_ = lis.Close()
	}
}

func TestFooterWritePersistsAcrossReconnectAndClearsDedup(t *testing.T) {
	server := newFooterRuntimeServer(true)
	endpoint, stop := startFooterRuntimeServer(t, server)
	defer stop()

	maxReconnectAttempts := 3
	client := NewClient(LaserstreamConfig{
		Endpoint:             endpoint,
		APIKey:               "",
		MaxReconnectAttempts: &maxReconnectAttempts,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	updates := make(chan *SubscribeUpdate, 4)
	if err := client.SubscribeWithContext(ctx, &SubscribeRequest{
		BlockFooter: map[string]*SubscribeRequestFilterBlockFooter{
			"old-footer": {},
		},
	}, func(data *SubscribeUpdate) {
		updates <- proto.Clone(data).(*SubscribeUpdate)
	}, func(err error) {}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	var first *SubscribeUpdate
	select {
	case first = <-updates:
	case <-ctx.Done():
		t.Fatalf("timed out waiting for first footer: %v", ctx.Err())
	}
	if got := first.GetBlockFooter().GetBankId(); got != 7 {
		t.Fatalf("first footer bank_id = %d, want 7", got)
	}

	if err := client.Write(&SubscribeRequest{
		BlockFooter: map[string]*SubscribeRequestFilterBlockFooter{
			"new-footer": {},
		},
	}); err != nil {
		t.Fatalf("write: %v", err)
	}

	select {
	case <-server.writeObserved:
	case <-ctx.Done():
		t.Fatalf("server did not observe footer replacement write: %v", ctx.Err())
	}

	var second *SubscribeUpdate
	select {
	case second = <-updates:
	case <-ctx.Done():
		t.Fatalf("timed out waiting for reconnected footer: %v", ctx.Err())
	}
	client.Close()

	if second.GetBlockFooter().GetBankId() != 7 {
		t.Fatalf("second footer bank_id = %d, want 7", second.GetBlockFooter().GetBankId())
	}
	if len(second.Filters) != 1 || second.Filters[0] != "new-footer" {
		t.Fatalf("second footer filters = %v, want [new-footer]", second.Filters)
	}

	server.mu.Lock()
	defer server.mu.Unlock()

	if len(server.initialReqs) < 2 {
		t.Fatalf("expected two subscribe attempts, got %d", len(server.initialReqs))
	}
	if len(server.writeReqs) != 1 {
		t.Fatalf("expected one write request, got %d", len(server.writeReqs))
	}
	if _, ok := server.writeReqs[0].BlockFooter["new-footer"]; !ok {
		t.Fatalf("write request did not carry replacement footer filter: %+v", server.writeReqs[0].BlockFooter)
	}
	if _, ok := server.initialReqs[1].BlockFooter["new-footer"]; !ok {
		t.Fatalf("reconnect request lost replacement footer filter: %+v", server.initialReqs[1].BlockFooter)
	}
	if _, ok := server.initialReqs[1].BlockFooter["old-footer"]; ok {
		t.Fatalf("reconnect request unexpectedly kept old footer filter")
	}
	if server.initialReqs[1].FromSlot == nil || *server.initialReqs[1].FromSlot != 11 {
		t.Fatalf("reconnect from_slot = %v, want 11 from footer replay cursor", server.initialReqs[1].FromSlot)
	}
}

func TestFooterReplayDisabledDoesNotSuppressReconnectDelivery(t *testing.T) {
	server := newFooterRuntimeServer(false)
	endpoint, stop := startFooterRuntimeServer(t, server)
	defer stop()

	maxReconnectAttempts := 3
	replay := false
	client := NewClient(LaserstreamConfig{
		Endpoint:             endpoint,
		APIKey:               "",
		MaxReconnectAttempts: &maxReconnectAttempts,
		Replay:               &replay,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	var mu sync.Mutex
	count := 0
	done := make(chan struct{}, 1)
	if err := client.SubscribeWithContext(ctx, &SubscribeRequest{
		BlockFooter: map[string]*SubscribeRequestFilterBlockFooter{
			"old-footer": {},
		},
	}, func(data *SubscribeUpdate) {
		mu.Lock()
		defer mu.Unlock()
		count++
		if count == 2 {
			select {
			case done <- struct{}{}:
			default:
			}
		}
	}, func(err error) {}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	select {
	case <-done:
		client.Close()
	case <-ctx.Done():
		t.Fatalf("timed out waiting for duplicate live footer after reconnect: %v", ctx.Err())
	}

	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.initialReqs) < 2 {
		t.Fatalf("expected two subscribe attempts, got %d", len(server.initialReqs))
	}
	if server.initialReqs[1].FromSlot != nil {
		t.Fatalf("replay=false should keep from_slot unset, got %v", *server.initialReqs[1].FromSlot)
	}
}
