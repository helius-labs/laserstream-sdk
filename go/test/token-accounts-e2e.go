// Live e2e for the tokenAccounts (ATA expansion) transaction filter.
//
// One stream, three filters over the same wallet:
//
//	base — plain AccountInclude (no expansion)
//	bc   — TokenAccounts: BALANCE_CHANGED
//	all  — TokenAccounts: ALL
//
// SubscribeUpdate.Filters tells us which filters matched each tx, so we can
// verify:
//  1. bc / all are supersets of base;
//  2. expansion-only matches exist where the wallet pubkey is NOT among the
//     tx account keys (incl. loaded ALT addresses) but IS an owner in
//     pre/post token balances — proof the server matched via owner
//     resolution, not the static key list;
//  3. Write() with a tokenAccounts filter keeps the stream working.
//
// Usage: go run test/token-accounts-e2e.go <endpoint> <api-key> <wallet> [seconds]
package main

import (
	"fmt"
	"math/big"
	"os"
	"sort"
	"strconv"
	"sync"
	"time"

	laserstream "github.com/helius-labs/laserstream-sdk/go"
)

const b58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

func base58Encode(b []byte) string {
	x := new(big.Int).SetBytes(b)
	base := big.NewInt(58)
	mod := new(big.Int)
	var out []byte
	for x.Sign() > 0 {
		x.DivMod(x, base, mod)
		out = append(out, b58Alphabet[mod.Int64()])
	}
	for _, c := range b {
		if c != 0 {
			break
		}
		out = append(out, '1')
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

type stats struct {
	mu             sync.Mutex
	counts         map[string]int
	expansionOnly  int // matched bc/all but not base
	expansionProof int // expansion-only AND wallet absent from account keys AND wallet owns a token balance
	baseNotBc      int // matched base but not bc (expected: base ⊆ all, bc can differ)
	sampleSigs     []string
	postWriteBc    int
	errors         []string
}

func main() {
	if len(os.Args) < 4 {
		fmt.Println("usage: token-accounts-e2e <endpoint> <api-key> <wallet> [seconds]")
		os.Exit(2)
	}
	endpoint, apiKey, wallet := os.Args[1], os.Args[2], os.Args[3]
	runSecs := 90
	if len(os.Args) > 4 {
		runSecs, _ = strconv.Atoi(os.Args[4])
	}

	s := &stats{counts: map[string]int{}}
	commitment := laserstream.CommitmentLevel_PROCESSED
	vote, failed := false, false

	newFilter := func(mode *laserstream.TokenAccountExpansionControlFlag) *laserstream.SubscribeRequestFilterTransactions {
		return &laserstream.SubscribeRequestFilterTransactions{
			AccountInclude: []string{wallet},
			Vote:           &vote,
			Failed:         &failed,
			TokenAccounts:  mode,
		}
	}

	req := &laserstream.SubscribeRequest{
		Transactions: map[string]*laserstream.SubscribeRequestFilterTransactions{
			"base": newFilter(nil),
			"bc":   newFilter(laserstream.TokenAccountExpansionControlFlag_BALANCE_CHANGED.Enum()),
			"all":  newFilter(laserstream.TokenAccountExpansionControlFlag_ALL.Enum()),
		},
		Commitment: &commitment,
	}

	client := laserstream.NewClient(laserstream.LaserstreamConfig{Endpoint: endpoint, APIKey: apiKey})

	writeAt := time.Now().Add(time.Duration(runSecs/2) * time.Second)
	var wroteMu sync.Mutex
	wrote := false

	onData := func(u *laserstream.SubscribeUpdate) {
		tx := u.GetTransaction()
		if tx == nil {
			return
		}
		matched := map[string]bool{}
		for _, f := range u.Filters {
			matched[f] = true
		}

		s.mu.Lock()
		defer s.mu.Unlock()
		for f := range matched {
			s.counts[f]++
		}

		wroteMu.Lock()
		w := wrote
		wroteMu.Unlock()
		if w && matched["bc2"] {
			s.postWriteBc++
		}

		if (matched["bc"] || matched["all"]) && !matched["base"] {
			s.expansionOnly++
			// Wallet must not be in the static account keys...
			inKeys := false
			msg := tx.GetTransaction().GetTransaction().GetMessage()
			meta := tx.GetTransaction().GetMeta()
			var keys [][]byte
			if msg != nil {
				keys = append(keys, msg.AccountKeys...)
			}
			if meta != nil {
				keys = append(keys, meta.LoadedWritableAddresses...)
				keys = append(keys, meta.LoadedReadonlyAddresses...)
			}
			for _, k := range keys {
				if base58Encode(k) == wallet {
					inKeys = true
					break
				}
			}
			// ...but must own a pre/post token balance.
			ownsBalance := false
			if meta != nil {
				for _, tb := range meta.PreTokenBalances {
					if tb.Owner == wallet {
						ownsBalance = true
					}
				}
				for _, tb := range meta.PostTokenBalances {
					if tb.Owner == wallet {
						ownsBalance = true
					}
				}
			}
			if !inKeys && ownsBalance {
				s.expansionProof++
				if len(s.sampleSigs) < 5 {
					s.sampleSigs = append(s.sampleSigs, base58Encode(tx.GetTransaction().GetSignature()))
				}
			}
		}
		if matched["base"] && !matched["all"] {
			s.baseNotBc++
		}
	}

	onErr := func(err error) {
		s.mu.Lock()
		s.errors = append(s.errors, err.Error())
		s.mu.Unlock()
		fmt.Printf("stream error: %v\n", err)
	}

	if err := client.Subscribe(req, onData, onErr); err != nil {
		fmt.Printf("FAIL subscribe: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("subscribed; running %ds against %s wallet=%s\n", runSecs, endpoint, wallet)

	// Halfway through, exercise Write() with a tokenAccounts filter.
	go func() {
		time.Sleep(time.Until(writeAt))
		wreq := &laserstream.SubscribeRequest{
			Transactions: map[string]*laserstream.SubscribeRequestFilterTransactions{
				"base": newFilter(nil),
				"bc":   newFilter(laserstream.TokenAccountExpansionControlFlag_BALANCE_CHANGED.Enum()),
				"all":  newFilter(laserstream.TokenAccountExpansionControlFlag_ALL.Enum()),
				"bc2":  newFilter(laserstream.TokenAccountExpansionControlFlag_BALANCE_CHANGED.Enum()),
			},
			Commitment: &commitment,
		}
		if err := client.Write(wreq); err != nil {
			s.mu.Lock()
			s.errors = append(s.errors, "write: "+err.Error())
			s.mu.Unlock()
			fmt.Printf("FAIL write: %v\n", err)
			return
		}
		wroteMu.Lock()
		wrote = true
		wroteMu.Unlock()
		fmt.Println("write() sent: added bc2 filter with BALANCE_CHANGED")
	}()

	time.Sleep(time.Duration(runSecs) * time.Second)
	client.Unsubscribe()

	s.mu.Lock()
	defer s.mu.Unlock()
	var names []string
	for k := range s.counts {
		names = append(names, k)
	}
	sort.Strings(names)
	fmt.Println("\n=== RESULTS ===")
	for _, n := range names {
		fmt.Printf("filter %-5s matched %d txs\n", n, s.counts[n])
	}
	fmt.Printf("expansion-only matches (bc/all but not base): %d\n", s.expansionOnly)
	fmt.Printf("expansion PROOF (wallet not in keys, owns token balance): %d\n", s.expansionProof)
	fmt.Printf("base-but-not-all (should be 0): %d\n", s.baseNotBc)
	fmt.Printf("post-write bc2 matches: %d\n", s.postWriteBc)
	for _, sig := range s.sampleSigs {
		fmt.Printf("  proof sig: %s\n", sig)
	}
	fmt.Printf("stream errors: %d %v\n", len(s.errors), s.errors)

	ok := s.counts["all"] >= s.counts["base"] && s.expansionProof > 0 && s.baseNotBc == 0 && len(s.errors) == 0 && s.postWriteBc > 0
	if ok {
		fmt.Println("PASS")
	} else {
		fmt.Println("FAIL (see criteria above)")
		os.Exit(1)
	}
}
