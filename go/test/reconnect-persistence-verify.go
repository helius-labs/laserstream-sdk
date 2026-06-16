package main

import (
	"fmt"
	"os"
	"sync"
	"time"

	laserstream "github.com/helius-labs/laserstream-sdk/go"
	"github.com/joho/godotenv"
)

// Direct verification of Go reconnect + replay + write-persistence through the
// chaos proxy. Mirrors the JS reconnect-replay-verify harness. The SDK only
// surfaces errors to the callback after exhausting all retries, so we detect
// reconnect windows via data gaps and verify the last write() persists across them.
//
//	LASERSTREAM_ENDPOINT=http://localhost:4003 LASERSTREAM_API_KEY=... \
//	  go run test/reconnect-persistence-verify.go
const (
	USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
)

func main() {
	godotenv.Load("../.env")
	endpoint := os.Getenv("LASERSTREAM_ENDPOINT")
	if endpoint == "" {
		endpoint = "http://localhost:4003"
	}
	apiKey := os.Getenv("LASERSTREAM_API_KEY")

	runMs := 110000
	writeAtMs := 10000
	postWriteGraceMs := int64(8000)

	var mu sync.Mutex
	var maxSlot uint64
	lastDataAt := time.Now()
	var writeAt time.Time
	gaps := 0
	postWriteReconnects := 0
	rewindsAfterReconnect := 0
	inGap := false
	var firstPostWriteGapAt time.Time

	type fEntry struct {
		t       time.Time
		filters []string
	}
	var txTimeline []fEntry

	client := laserstream.NewClient(laserstream.LaserstreamConfig{Endpoint: endpoint, APIKey: apiKey})

	commit := laserstream.CommitmentLevel_PROCESSED
	fbc := true
	isu := false
	voteF := false

	req := &laserstream.SubscribeRequest{
		Transactions: map[string]*laserstream.SubscribeRequestFilterTransactions{
			"usdc": {Vote: &voteF, Failed: &voteF, AccountInclude: []string{USDC}},
		},
		Slots:      map[string]*laserstream.SubscribeRequestFilterSlots{"slots": {FilterByCommitment: &fbc, InterslotUpdates: &isu}},
		Commitment: &commit,
	}

	dataCb := func(u *laserstream.SubscribeUpdate) {
		mu.Lock()
		defer mu.Unlock()
		now := time.Now()
		since := now.Sub(lastDataAt).Seconds()
		if since > 4 {
			gaps++
			inGap = true
			sinceWrite := int64(-1)
			if !writeAt.IsZero() {
				sinceWrite = now.Sub(writeAt).Milliseconds()
			}
			if sinceWrite > postWriteGraceMs {
				postWriteReconnects++
				if firstPostWriteGapAt.IsZero() {
					firstPostWriteGapAt = now
				}
			}
			fmt.Printf("[gap] data resumed after %.1fs silence (reconnect window #%d)\n", since, gaps)
		}
		lastDataAt = now

		switch up := u.UpdateOneof.(type) {
		case *laserstream.SubscribeUpdate_Slot:
			if up.Slot != nil {
				s := up.Slot.Slot
				if s != 0 && maxSlot != 0 && s < maxSlot-1 {
					if inGap {
						rewindsAfterReconnect++
						fmt.Printf("[replay] slot rewound %d -> %d (Δ%d) after reconnect\n", maxSlot, s, maxSlot-s)
						inGap = false
					}
				}
				if s > maxSlot {
					maxSlot = s
				}
			}
		case *laserstream.SubscribeUpdate_Transaction:
			txTimeline = append(txTimeline, fEntry{t: now, filters: u.Filters})
		}
	}
	errCb := func(err error) { fmt.Printf("[onError callback] %v\n", err) }

	if err := client.Subscribe(req, dataCb, errCb); err != nil {
		fmt.Printf("subscribe failed: %v\n", err)
		os.Exit(2)
	}

	time.Sleep(time.Duration(writeAtMs) * time.Millisecond)
	fmt.Println("[write] replacing USDC filter with USDT...")
	writeReq := &laserstream.SubscribeRequest{
		Transactions: map[string]*laserstream.SubscribeRequestFilterTransactions{
			"usdt": {Vote: &voteF, Failed: &voteF, AccountInclude: []string{USDT}},
		},
		Slots:      map[string]*laserstream.SubscribeRequestFilterSlots{"slots": {FilterByCommitment: &fbc, InterslotUpdates: &isu}},
		Commitment: &commit,
	}
	if err := client.Write(writeReq); err != nil {
		fmt.Printf("write failed: %v\n", err)
		os.Exit(2)
	}
	mu.Lock()
	writeAt = time.Now()
	mu.Unlock()

	time.Sleep(time.Duration(runMs-writeAtMs) * time.Millisecond)
	client.Close()
	time.Sleep(500 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	flat := func(pred func(fEntry) bool) map[string]bool {
		set := map[string]bool{}
		for _, e := range txTimeline {
			if pred(e) {
				for _, f := range e.filters {
					set[f] = true
				}
			}
		}
		return set
	}
	fb := flat(func(e fEntry) bool { return !writeAt.IsZero() && e.t.Before(writeAt) })
	fa := flat(func(e fEntry) bool {
		return !writeAt.IsZero() && e.t.After(writeAt.Add(time.Duration(postWriteGraceMs)*time.Millisecond))
	})
	far := flat(func(e fEntry) bool {
		return !firstPostWriteGapAt.IsZero() && e.t.After(firstPostWriteGapAt.Add(2*time.Second))
	})

	fmt.Println("\n================ GO RECONNECT/REPLAY VERIFICATION ================")
	fmt.Printf("run duration:                 %ds\n", runMs/1000)
	fmt.Printf("reconnect windows (gaps>4s):  %d  (post-write: %d)\n", gaps, postWriteReconnects)
	fmt.Printf("replay rewinds after reconnect: %d\n", rewindsAfterReconnect)
	fmt.Printf("max slot reached:             %d\n", maxSlot)
	fmt.Printf("tx filters BEFORE write:      %v\n", keys(fb))
	fmt.Printf("tx filters AFTER write+grace: %v\n", keys(fa))
	fmt.Printf("tx filters AFTER reconnect:   %v\n", keys(far))
	fmt.Println("---------------------------------------------------------------")

	allPass := true
	check := func(name string, ok bool) {
		if !ok {
			allPass = false
		}
		st := "PASS"
		if !ok {
			st = "FAIL"
		}
		fmt.Printf("  %s  %s\n", st, name)
	}
	check("USDC flowed before write", fb["usdc"])
	check("write replaced USDC->USDT (no USDC after write+grace)", !fa["usdc"] && fa["usdt"])
	check("at least one reconnect window observed", gaps > 0)
	check("replay rewind observed after a reconnect", rewindsAfterReconnect > 0)
	if postWriteReconnects > 0 {
		check("write persisted after reconnect (USDT present, USDC absent)", far["usdt"] && !far["usdc"])
	} else {
		fmt.Println("NOTE: no post-write reconnect occurred; write-persistence-across-reconnect not exercised.")
	}
	fmt.Println("===============================================================")
	if allPass {
		fmt.Println("RESULT: PASS")
		os.Exit(0)
	}
	fmt.Println("RESULT: FAIL")
	os.Exit(1)
}

func keys(m map[string]bool) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	return out
}
