package main

import (
	"fmt"
	"os"
	"sync"
	"time"

	laserstream "github.com/helius-labs/laserstream-sdk/go"
	"github.com/joho/godotenv"
)

// Observes reconnect (data gap), replay (processed slot rewind ~31) and that a
// write() persists across reconnects — the stock tests can't see reconnects
// since the SDK only surfaces errors after max attempts. Needs the chaos proxy.
const (
	usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	usdt = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
)

type ev struct {
	t time.Time
	f []string
}

func main() {
	godotenv.Load("../.env")
	endpoint := os.Getenv("LASERSTREAM_ENDPOINT")
	if endpoint == "" {
		endpoint = "http://localhost:4003"
	}
	client := laserstream.NewClient(laserstream.LaserstreamConfig{Endpoint: endpoint, APIKey: os.Getenv("LASERSTREAM_API_KEY")})

	commit := laserstream.CommitmentLevel_PROCESSED
	no, fbc := false, true
	req := func(mint, id string) *laserstream.SubscribeRequest {
		return &laserstream.SubscribeRequest{
			Transactions: map[string]*laserstream.SubscribeRequestFilterTransactions{id: {Vote: &no, Failed: &no, AccountInclude: []string{mint}}},
			Slots:        map[string]*laserstream.SubscribeRequestFilterSlots{"slots": {FilterByCommitment: &fbc}},
			Commitment:   &commit,
		}
	}

	var mu sync.Mutex
	var maxSlot uint64
	last, gaps, rewinds, inGap := time.Now(), 0, 0, false
	var writeAt, firstGapAfterWrite time.Time
	var txAt []ev

	dataCb := func(u *laserstream.SubscribeUpdate) {
		mu.Lock()
		defer mu.Unlock()
		now := time.Now()
		if now.Sub(last) > 4*time.Second {
			gaps++
			inGap = true
			if !writeAt.IsZero() && now.Sub(writeAt) > 8*time.Second && firstGapAfterWrite.IsZero() {
				firstGapAfterWrite = now
			}
			fmt.Printf("[gap] reconnect window #%d\n", gaps)
		}
		last = now
		switch up := u.UpdateOneof.(type) {
		case *laserstream.SubscribeUpdate_Slot:
			if up.Slot != nil {
				s := up.Slot.Slot
				if maxSlot != 0 && s < maxSlot-1 && inGap {
					rewinds++
					fmt.Printf("[replay] rewind %d->%d (Δ%d)\n", maxSlot, s, maxSlot-s)
					inGap = false
				}
				if s > maxSlot {
					maxSlot = s
				}
			}
		case *laserstream.SubscribeUpdate_Transaction:
			txAt = append(txAt, ev{now, u.Filters})
		}
	}

	if err := client.Subscribe(req(usdc, "usdc"), dataCb, func(error) {}); err != nil {
		fmt.Println("subscribe failed:", err)
		os.Exit(2)
	}

	// write only once data is flowing (live connection) so it isn't lost mid-disconnect;
	// a later reconnect then exercises persistence
	for i := 0; i < 80; i++ {
		mu.Lock()
		n := len(txAt)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	time.Sleep(2 * time.Second)
	fmt.Println("[write] USDC -> USDT")
	if err := client.Write(req(usdt, "usdt")); err != nil {
		fmt.Println("write failed:", err)
		os.Exit(2)
	}
	mu.Lock()
	writeAt = time.Now()
	mu.Unlock()

	time.Sleep(90 * time.Second)
	client.Close()
	time.Sleep(500 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	set := func(pred func(time.Time) bool) map[string]bool {
		m := map[string]bool{}
		for _, e := range txAt {
			if pred(e.t) {
				for _, f := range e.f {
					m[f] = true
				}
			}
		}
		return m
	}
	before := set(func(t time.Time) bool { return t.Before(writeAt) })
	after := set(func(t time.Time) bool { return t.After(writeAt.Add(8 * time.Second)) })
	afterRecon := map[string]bool{}
	if !firstGapAfterWrite.IsZero() {
		afterRecon = set(func(t time.Time) bool { return t.After(firstGapAfterWrite.Add(2 * time.Second)) })
	}

	fmt.Printf("\nreconnects=%d rewinds=%d maxSlot=%d\n", gaps, rewinds, maxSlot)
	ok := true
	check := func(name string, pass bool) {
		ok = ok && pass
		s := "PASS"
		if !pass {
			s = "FAIL"
		}
		fmt.Printf("  %s  %s\n", s, name)
	}
	check("USDC before write", before["usdc"])
	check("write replaced USDC->USDT", !after["usdc"] && after["usdt"])
	check("reconnect observed", gaps > 0)
	check("replay rewind after reconnect", rewinds > 0)
	if !firstGapAfterWrite.IsZero() {
		check("write persisted after reconnect", afterRecon["usdt"] && !afterRecon["usdc"])
	}
	if ok {
		fmt.Println("RESULT: PASS")
		os.Exit(0)
	}
	fmt.Println("RESULT: FAIL")
	os.Exit(1)
}
