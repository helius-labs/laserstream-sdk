package laserstream

import (
	"context"
	"encoding/hex"
	"net"
	"testing"
	"time"

	pb "github.com/helius-labs/laserstream-sdk/go/proto"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
)

func TestAccountIndexActualSubscribe(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	pb.RegisterGeyserServer(server, &accountIndexServer{})
	go server.Serve(listener)
	defer server.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client := NewClient(NewLaserstreamConfig("http://"+listener.Addr().String(), ""))
	defer client.Close()
	got := make(chan AccountTransactionIndex, 10)
	failures := make(chan error, 1)
	err = client.SubscribeWithContext(ctx, &SubscribeRequest{}, func(update *SubscribeUpdate) {
		account := update.GetAccount().GetAccount()
		if update.GetBlock() != nil {
			account = update.GetBlock().Accounts[0]
		}
		got <- account.AccountTransactionIndex()
	}, func(err error) {
		select {
		case failures <- err:
		default:
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []uint64{0, 0, 42, ^uint64(0), ^uint64(0) - 1} {
		for range []bool{false, true} {
			select {
			case actual := <-got:
				if actual != pb.DecodeAccountTransactionIndex(value) {
					t.Fatalf("got %v for %d", actual, value)
				}
			case err := <-failures:
				t.Fatal(err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
}

type accountIndexServer struct{ pb.UnimplementedGeyserServer }

func (*accountIndexServer) Subscribe(stream grpc.BidiStreamingServer[pb.SubscribeRequest, pb.SubscribeUpdate]) error {
	if _, err := stream.Recv(); err != nil {
		return err
	}
	for _, hexWire := range []string{"", "800200", "80022a", "8002ffffffffffffffffff01", "8002feffffffffffffffff01"} {
		info, _ := hex.DecodeString(hexWire)
		for _, block := range []bool{false, true} {
			innerTag, outerTag := byte(0x0a), byte(0x12)
			if block {
				innerTag, outerTag = 0x5a, 0x2a
			}
			nested := append([]byte{innerTag, byte(len(info))}, info...)
			wire := append([]byte{outerTag, byte(len(nested))}, nested...)
			var update pb.SubscribeUpdate
			if err := proto.Unmarshal(wire, &update); err != nil {
				return err
			}
			if err := stream.Send(&update); err != nil {
				return err
			}
		}
	}
	<-stream.Context().Done()
	return stream.Context().Err()
}
