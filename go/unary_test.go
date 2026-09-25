package laserstream

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	pb "github.com/helius-labs/laserstream-sdk/go/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

type unaryTestServer struct {
	pb.UnimplementedGeyserServer
}

// Commitment is encoded into numeric results so tests can verify it was sent.
func commitSlot(c *pb.CommitmentLevel) uint64 {
	if c == nil {
		return 999
	}
	return 1000 + uint64(*c)
}

func (unaryTestServer) GetSlot(_ context.Context, r *pb.GetSlotRequest) (*pb.GetSlotResponse, error) {
	return &pb.GetSlotResponse{Slot: commitSlot(r.Commitment)}, nil
}
func (unaryTestServer) GetBlockHeight(context.Context, *pb.GetBlockHeightRequest) (*pb.GetBlockHeightResponse, error) {
	return &pb.GetBlockHeightResponse{BlockHeight: 900}, nil
}
func (unaryTestServer) GetLatestBlockhash(_ context.Context, r *pb.GetLatestBlockhashRequest) (*pb.GetLatestBlockhashResponse, error) {
	return &pb.GetLatestBlockhashResponse{Slot: commitSlot(r.Commitment), Blockhash: "hash", LastValidBlockHeight: 7}, nil
}
func (unaryTestServer) IsBlockhashValid(_ context.Context, r *pb.IsBlockhashValidRequest) (*pb.IsBlockhashValidResponse, error) {
	return &pb.IsBlockhashValidResponse{Slot: 5, Valid: r.Blockhash == "hash"}, nil
}
func (unaryTestServer) GetVersion(ctx context.Context, _ *pb.GetVersionRequest) (*pb.GetVersionResponse, error) {
	md, _ := metadata.FromIncomingContext(ctx)
	get := func(k string) string {
		if v := md.Get(k); len(v) > 0 {
			return v[0]
		}
		return ""
	}
	return &pb.GetVersionResponse{Version: get("x-token") + "|" + get("x-sdk-name")}, nil
}
func (unaryTestServer) Ping(_ context.Context, r *pb.PingRequest) (*pb.PongResponse, error) {
	return &pb.PongResponse{Count: r.Count}, nil
}
func (unaryTestServer) SubscribeReplayInfo(context.Context, *pb.SubscribeReplayInfoRequest) (*pb.SubscribeReplayInfoResponse, error) {
	first := uint64(42)
	return &pb.SubscribeReplayInfoResponse{FirstAvailable: &first}, nil
}

func startUnaryTestServer(t *testing.T) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer()
	pb.RegisterGeyserServer(srv, unaryTestServer{})
	go srv.Serve(lis)
	t.Cleanup(srv.Stop)
	return "http://" + lis.Addr().String()
}

func TestUnaryMethods(t *testing.T) {
	cfg := NewLaserstreamConfig(startUnaryTestServer(t), "secret")
	client := NewClient(cfg)
	defer client.Close()
	ctx := context.Background()

	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}

	slot, err := client.GetSlot(ctx)
	must(err)
	if slot.Slot != 999 {
		t.Errorf("GetSlot() = %d, want 999", slot.Slot)
	}
	slot, err = client.GetSlot(ctx, CommitmentLevel_FINALIZED)
	must(err)
	if slot.Slot != 1002 {
		t.Errorf("GetSlot(FINALIZED) = %d, want 1002", slot.Slot)
	}

	height, err := client.GetBlockHeight(ctx)
	must(err)
	if height.BlockHeight != 900 {
		t.Errorf("GetBlockHeight = %d", height.BlockHeight)
	}

	bh, err := client.GetLatestBlockhash(ctx, CommitmentLevel_CONFIRMED)
	must(err)
	if bh.Slot != 1001 || bh.Blockhash != "hash" || bh.LastValidBlockHeight != 7 {
		t.Errorf("GetLatestBlockhash = %+v", bh)
	}

	valid, err := client.IsBlockhashValid(ctx, bh.Blockhash)
	must(err)
	if !valid.Valid {
		t.Error("IsBlockhashValid(hash) = false")
	}
	valid, err = client.IsBlockhashValid(ctx, "nope")
	must(err)
	if valid.Valid {
		t.Error("IsBlockhashValid(nope) = true")
	}

	ver, err := client.GetVersion(ctx)
	must(err)
	if want := "secret|" + SDKName; ver.Version != want {
		t.Errorf("GetVersion = %q, want %q", ver.Version, want)
	}

	pong, err := client.Ping(ctx, 7)
	must(err)
	if pong.Count != 7 {
		t.Errorf("Ping = %d", pong.Count)
	}

	replay, err := client.SubscribeReplayInfo(ctx)
	must(err)
	if replay.FirstAvailable == nil || *replay.FirstAvailable != 42 {
		t.Errorf("SubscribeReplayInfo = %v", replay.FirstAvailable)
	}

	// Close drops the unary connection; the next call transparently re-dials.
	client.Close()
	_, err = client.Ping(ctx, 1)
	must(err)
}

func TestUnaryConcurrent(t *testing.T) {
	client := NewClient(NewLaserstreamConfig(startUnaryTestServer(t), ""))
	defer client.Close()

	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		go func(i int32) {
			pong, err := client.Ping(context.Background(), i)
			if err == nil && pong.Count != i {
				err = fmt.Errorf("ping %d echoed %d", i, pong.Count)
			}
			errs <- err
		}(int32(i))
	}
	for i := 0; i < 20; i++ {
		if err := <-errs; err != nil {
			t.Error(err)
		}
	}
}

func TestUnaryUnreachableRespectsDeadline(t *testing.T) {
	client := NewClient(NewLaserstreamConfig("http://127.0.0.1:1", ""))
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	start := time.Now()
	if _, err := client.GetSlot(ctx); err == nil {
		t.Fatal("expected error for unreachable endpoint")
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("call did not respect context deadline")
	}
}
