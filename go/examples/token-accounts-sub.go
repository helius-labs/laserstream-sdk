// tokenAccounts (ATA) transaction filter.
//
// Subscribe to transactions touching a wallet *and* its Associated Token
// Accounts (ATAs) by setting the `TokenAccounts` field on a transaction
// filter alongside `AccountInclude`. Modes:
//
//   - unset (nil)                                        — no expansion (default).
//   - TokenAccountExpansionControlFlag_BALANCE_CHANGED   — also match txs touching
//     an ATA owned by an AccountInclude wallet whose token balance changed.
//   - TokenAccountExpansionControlFlag_ALL               — match any tx touching
//     an ATA owned by an AccountInclude wallet.
//
// Run with: go run examples/token-accounts-sub.go
package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"

	laserstream "github.com/helius-labs/laserstream-sdk/go"

	"github.com/joho/godotenv"
)

func main() {
	log.SetFlags(0)

	godotenv.Load("../.env")

	endpoint := os.Getenv("LASERSTREAM_ENDPOINT")
	apiKey := os.Getenv("LASERSTREAM_API_KEY")
	if endpoint == "" || apiKey == "" {
		log.Fatal("LASERSTREAM_ENDPOINT and LASERSTREAM_API_KEY must be set")
	}

	// Example wallet to watch; replace with your own.
	wallet := os.Getenv("WATCH_WALLET")
	if wallet == "" {
		wallet = "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg"
	}

	clientConfig := laserstream.LaserstreamConfig{
		Endpoint: endpoint,
		APIKey:   apiKey,
	}

	commitmentLevel := laserstream.CommitmentLevel_CONFIRMED
	vote := false
	failed := false
	subscriptionRequest := &laserstream.SubscribeRequest{
		Transactions: map[string]*laserstream.SubscribeRequestFilterTransactions{
			"wallet-and-atas": {
				AccountInclude: []string{wallet},
				Vote:           &vote,
				Failed:         &failed,
				// Expand the subscription to ATAs owned by the watched wallet
				// whose token balance changed in the transaction.
				TokenAccounts: laserstream.TokenAccountExpansionControlFlag_BALANCE_CHANGED.Enum(),
			},
		},
		Commitment: &commitmentLevel,
	}

	client := laserstream.NewClient(clientConfig)

	dataCallback := func(data *laserstream.SubscribeUpdate) {
		if tx := data.GetTransaction(); tx != nil {
			log.Printf("slot=%d sig=%x", tx.Slot, tx.GetTransaction().GetSignature())
		}
	}

	errorCallback := func(err error) {
		log.Printf("Error: %v", err)
	}

	err := client.Subscribe(subscriptionRequest, dataCallback, errorCallback)
	if err != nil {
		log.Fatalf("Failed to subscribe: %v", err)
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	client.Unsubscribe()
}
