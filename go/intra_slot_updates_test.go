package laserstream

import (
	"net"
	"strings"
	"sync"
	"testing"

	pb "github.com/helius-labs/laserstream-sdk/go/v2/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const slotTooOld = "Requested slot 95 is older than the oldest available slot 100. Please request a more recent slot."

// The x-intra-slot-updates and x-disable-geyser-archive values of one Subscribe call.
type subscribeHeaders struct {
	intraSlotUpdates []string
	disableArchive   []string
}

// Answers every Subscribe with OUT_OF_RANGE, recording its headers and signaling each call on subscribed.
type outOfRangeServer struct {
	pb.UnimplementedGeyserServer
	mu         sync.Mutex
	subscribes []subscribeHeaders
	subscribed chan struct{}
}

func (s *outOfRangeServer) Subscribe(stream pb.Geyser_SubscribeServer) error {
	md, _ := metadata.FromIncomingContext(stream.Context())
	s.mu.Lock()
	s.subscribes = append(s.subscribes, subscribeHeaders{md.Get("x-intra-slot-updates"), md.Get("x-disable-geyser-archive")})
	s.mu.Unlock()
	select {
	case s.subscribed <- struct{}{}:
	default:
	}
	return status.Error(codes.OutOfRange, slotTooOld)
}

func (s *outOfRangeServer) recorded() []subscribeHeaders {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]subscribeHeaders(nil), s.subscribes...)
}

func TestIntraSlotSubscriptionSendsTheHeaderAndStopsAtOutOfRange(t *testing.T) {
	server, endpoint := startOutOfRangeServer(t)
	cfg := NewLaserstreamConfig(endpoint, "")
	cfg.IntraSlotUpdates = true
	errs := make(chan error, 1)
	client := subscribeFromSlot95(t, cfg, func(err error) { errs <- err })
	defer client.Close()

	// The error callback fires only when the stream loop gives up, so no retry follows it.
	err := <-errs

	if !strings.Contains(err.Error(), "older than the oldest available slot") {
		t.Fatalf("error = %v, want OUT_OF_RANGE", err)
	}
	subscribes := server.recorded()
	if len(subscribes) != 1 {
		t.Fatalf("subscribes = %d, want 1 (no retry)", len(subscribes))
	}
	if got := subscribes[0]; len(got.intraSlotUpdates) != 1 || got.intraSlotUpdates[0] != "true" || len(got.disableArchive) != 0 {
		t.Fatalf("headers = %+v, want only x-intra-slot-updates: true", got)
	}
}

func TestDefaultSubscriptionSendsNoIntraSlotHeader(t *testing.T) {
	server, endpoint := startOutOfRangeServer(t)
	client := subscribeFromSlot95(t, NewLaserstreamConfig(endpoint, ""), func(err error) { t.Errorf("unexpected error: %v", err) })
	defer client.Close()

	<-server.subscribed

	if got := server.recorded()[0]; len(got.intraSlotUpdates) != 0 || len(got.disableArchive) != 0 {
		t.Fatalf("headers = %+v, want none", got)
	}
}

func TestIntraSlotUpdatesAreOffByDefault(t *testing.T) {
	if NewLaserstreamConfig("", "").IntraSlotUpdates {
		t.Fatal("IntraSlotUpdates defaults to true")
	}
}

func startOutOfRangeServer(t *testing.T) (*outOfRangeServer, string) {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &outOfRangeServer{subscribed: make(chan struct{}, 1)}
	srv := grpc.NewServer()
	pb.RegisterGeyserServer(srv, server)
	go srv.Serve(lis)
	t.Cleanup(srv.Stop)
	return server, "http://" + lis.Addr().String()
}

func subscribeFromSlot95(t *testing.T, cfg LaserstreamConfig, onError ErrorCallback) *Client {
	t.Helper()
	client := NewClient(cfg)
	fromSlot := uint64(95)
	req := &SubscribeRequest{
		Accounts: map[string]*SubscribeRequestFilterAccounts{"accounts": {}},
		FromSlot: &fromSlot,
	}
	if err := client.Subscribe(req, func(*SubscribeUpdate) {}, onError); err != nil {
		t.Fatal(err)
	}
	return client
}
