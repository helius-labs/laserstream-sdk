package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sync"

	ls "github.com/helius-labs/laserstream-sdk/go"
	pb "github.com/helius-labs/laserstream-sdk/go/proto"
	"github.com/mr-tron/base58"
	"google.golang.org/protobuf/encoding/protojson"
)

var output sync.Mutex

func emit(v any) {
	output.Lock()
	defer output.Unlock()
	b, _ := json.Marshal(v)
	fmt.Println(string(b))
}
func update(u *ls.SubscribeUpdate) {
	if tx := u.GetTransaction(); tx != nil {
		t := tx.GetTransaction()
		m := t.GetMeta()
		keys := []string{}
		for _, b := range t.GetTransaction().GetMessage().GetAccountKeys() {
			keys = append(keys, base58.Encode(b))
		}
		for _, b := range m.GetLoadedWritableAddresses() {
			keys = append(keys, base58.Encode(b))
		}
		for _, b := range m.GetLoadedReadonlyAddresses() {
			keys = append(keys, base58.Encode(b))
		}
		// Marshal balance messages with protojson to retain string u64 amounts.
		balances := func(pre bool) []json.RawMessage {
			list := m.GetPostTokenBalances()
			if pre {
				list = m.GetPreTokenBalances()
			}
			result := []json.RawMessage{}
			for _, b := range list {
				data, _ := protojson.Marshal(b)
				result = append(result, data)
			}
			return result
		}
		emit(map[string]any{"type": "transaction", "filters": u.Filters, "slot": tx.Slot,
			"signature": base58.Encode(t.Signature), "vote": t.IsVote, "failed": m.GetErr() != nil,
			"keys": keys, "pre": balances(true), "post": balances(false)})
	} else if t := u.GetTransactionStatus(); t != nil {
		emit(map[string]any{"type": "status", "filters": u.Filters, "slot": t.Slot,
			"signature": base58.Encode(t.Signature), "vote": t.IsVote, "failed": t.Err != nil})
	} else if s := u.GetSlot(); s != nil {
		emit(map[string]any{"type": "slot", "filters": u.Filters, "slot": s.Slot})
	}
}
func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), 16*1024*1024)
	var client *ls.Client
	for scanner.Scan() {
		var c struct {
			Action  string
			ID      string
			Request json.RawMessage
			Replay  *bool
		}
		if err := json.Unmarshal(scanner.Bytes(), &c); err != nil {
			panic(err)
		}
		if c.Action == "stop" {
			if client != nil {
				client.Close()
			}
			return
		}
		request := &pb.SubscribeRequest{}
		err := protojson.Unmarshal(c.Request, request)
		if err == nil && c.Action == "subscribe" {
			retries := 3
			client = ls.NewClient(ls.LaserstreamConfig{Endpoint: os.Getenv("MINT_ENDPOINT"),
				APIKey: os.Getenv("MINT_API_KEY"), Replay: c.Replay, MaxReconnectAttempts: &retries})
			err = client.Subscribe(request, update, func(e error) { emit(map[string]any{"type": "error", "message": e.Error()}) })
		} else if err == nil {
			err = client.Write(request)
		}
		if err != nil {
			emit(map[string]any{"type": "commandError", "id": c.ID, "message": err.Error()})
		} else {
			emit(map[string]any{"type": "ack", "id": c.ID})
		}
	}
	if err := scanner.Err(); err != nil {
		panic(err)
	}
}
