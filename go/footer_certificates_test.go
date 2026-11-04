package laserstream

import (
	"bytes"
	"net"
	"testing"

	pb "github.com/helius-labs/laserstream-sdk/go/v2/proto"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
)

// Records the first SubscribeRequest, answers with one footer, then holds the stream open.
type footerServer struct {
	pb.UnimplementedGeyserServer
	footer   *SubscribeUpdate
	requests chan *SubscribeRequest
}

func (s *footerServer) Subscribe(stream pb.Geyser_SubscribeServer) error {
	req, err := stream.Recv()
	if err != nil {
		return err
	}
	s.requests <- req
	if err := stream.Send(s.footer); err != nil {
		return err
	}
	<-stream.Context().Done()
	return nil
}

func TestFooterCertificatesProtoRoundTrip(t *testing.T) {
	filterWire, err := proto.Marshal(&SubscribeRequestFilterBlockFooter{IncludeCertificates: proto.Bool(true)})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(filterWire, []byte{0x08, 0x01}) {
		t.Fatalf("include_certificates wire = %x, want 0801", filterWire)
	}

	want := footerWithCertificates()
	wire, err := proto.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	decoded := new(SubscribeUpdate)
	if err := proto.Unmarshal(wire, decoded); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(decoded, want) {
		t.Fatalf("footer round trip = %+v, want %+v", decoded, want)
	}
}

func TestSubscribeSendsIncludeCertificatesAndDeliversCertificates(t *testing.T) {
	server, endpoint := startFooterServer(t, footerWithCertificates())
	client := NewClient(NewLaserstreamConfig(endpoint, ""))
	defer client.Close()
	updates := make(chan *SubscribeUpdate, 1)
	req := &SubscribeRequest{
		BlockFooter: map[string]*SubscribeRequestFilterBlockFooter{
			"footer": {IncludeCertificates: proto.Bool(true)},
		},
	}
	if err := client.Subscribe(req, func(u *SubscribeUpdate) { updates <- u }, func(err error) { t.Errorf("unexpected error: %v", err) }); err != nil {
		t.Fatal(err)
	}

	sent := <-server.requests
	got := <-updates

	if filter := sent.GetBlockFooter()["footer"]; filter == nil || !filter.GetIncludeCertificates() {
		t.Fatalf("sent footer filters = %+v, want footer with include_certificates", sent.GetBlockFooter())
	}
	if !proto.Equal(got.GetBlockFooter(), footerWithCertificates().GetBlockFooter()) {
		t.Fatalf("received footer = %+v", got.GetBlockFooter())
	}
}

func startFooterServer(t *testing.T, footer *SubscribeUpdate) (*footerServer, string) {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &footerServer{footer: footer, requests: make(chan *SubscribeRequest, 1)}
	srv := grpc.NewServer()
	pb.RegisterGeyserServer(srv, server)
	go srv.Serve(lis)
	t.Cleanup(srv.Stop)
	return server, "http://" + lis.Addr().String()
}

func footerWithCertificates() *SubscribeUpdate {
	aggregate := func(fill byte, blockID []byte) *BlockFooterVotesAggregate {
		return &BlockFooterVotesAggregate{
			SignatureKind: BlockFooterSignatureKind_COMPRESSED_BLS12_381_G2,
			Signature:     bytes.Repeat([]byte{fill}, 96),
			BlockId:       blockID,
			SignerBitmap:  []byte{1, 3, 0, 0b101},
		}
	}
	blockID := bytes.Repeat([]byte{0xbb}, 32)
	return &SubscribeUpdate{
		Filters: []string{"footer"},
		UpdateOneof: &SubscribeUpdate_BlockFooter{
			BlockFooter: &SubscribeUpdateBlockFooter{
				Slot:                   42,
				BankId:                 7,
				BankHash:               bytes.Repeat([]byte{0xaa}, 32),
				BlockProducerTimeNanos: 1_700_000_000_000_000_000,
				BlockUserAgent:         []byte("agave/4.3"),
				BlockFinalCert: &BlockFooterFinalCert{
					Slot:           40,
					FinalAggregate: aggregate(0x11, nil),
					NotarAggregate: aggregate(0x12, blockID),
				},
				SkipRewardCert:  &BlockFooterSkipRewardCert{Slot: 39, Aggregate: aggregate(0x13, nil)},
				NotarRewardCert: &BlockFooterNotarRewardCert{Slot: 41, Aggregate: aggregate(0x14, blockID)},
			},
		},
	}
}
