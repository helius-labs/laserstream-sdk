package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	laserstream "github.com/helius-labs/laserstream-sdk/go"
	"github.com/joho/godotenv"
)

func main() {
	log.SetFlags(0)

	// Load environment variables from root directory
	if err := godotenv.Load("../.env"); err != nil {
		fmt.Printf("Warning: Could not load .env file: %v\n", err)
	}

	endpoint := os.Getenv("LASERSTREAM_PRODUCTION_ENDPOINT")
	apiKey := os.Getenv("LASERSTREAM_PRODUCTION_API_KEY")

	// Fallback to regular endpoints if production not available
	if endpoint == "" {
		endpoint = os.Getenv("LASERSTREAM_ENDPOINT")
	}
	if apiKey == "" {
		apiKey = os.Getenv("LASERSTREAM_API_KEY")
	}

	if endpoint == "" || apiKey == "" {
		log.Fatal("Please set LASERSTREAM_PRODUCTION_ENDPOINT/LASERSTREAM_PRODUCTION_API_KEY or LASERSTREAM_ENDPOINT/LASERSTREAM_API_KEY environment variables")
	}

	fmt.Println("Testing stream.write functionality...")

	config := laserstream.LaserstreamConfig{
		Endpoint: endpoint,
		APIKey:   apiKey,
	}

	client := laserstream.NewClient(config)
	defer client.Close()

	// Initial request - subscribe to slots only
	commitmentLevel := laserstream.CommitmentLevel_PROCESSED
	initialRequest := &laserstream.SubscribeRequest{
		Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
			"slots-only": {},
		},
		Commitment: &commitmentLevel,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Set up signal handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// Statistics tracking
	var (
		slotCount        = 0
		transactionCount = 0
		accountCount     = 0
		totalMessages    = 0
		phase            = 1
		targetCounts     = map[int]int{1: 5, 2: 5, 3: 5} // Target counts for each phase
	)

	fmt.Println("Test Phase 1: Starting with slots subscription only")

	// Data handler
	dataHandler := func(update *laserstream.SubscribeUpdate) {
		totalMessages++

		switch u := update.UpdateOneof.(type) {
		case *laserstream.SubscribeUpdate_Slot:
			slotCount++
			fmt.Printf("📦 Slot %d (Phase %d: %d/%d)\n", u.Slot.Slot, phase, slotCount, targetCounts[phase])

			// Phase transitions
			if phase == 1 && slotCount >= targetCounts[1] {
				fmt.Printf("✅ Phase 1 complete: Received %d slot updates\n\n", slotCount)
				phase = 2
				transitionToPhase2(client)
			}

		case *laserstream.SubscribeUpdate_Transaction:
			transactionCount++
			if phase == 2 {
				fmt.Printf("💸 Transaction %s (Phase %d: %d/%d)\n",
					u.Transaction.Transaction.Signature, phase, transactionCount, targetCounts[2])

				if transactionCount >= targetCounts[2] {
					fmt.Printf("✅ Phase 2 complete: Received %d transactions\n\n", transactionCount)
					phase = 3
					transitionToPhase3(client)
				}
			}

		case *laserstream.SubscribeUpdate_Account:
			accountCount++
			if phase == 3 {
				fmt.Printf("👤 Account %s (Phase %d: %d/%d)\n",
					u.Account.Account.Pubkey, phase, accountCount, targetCounts[3])

				if accountCount >= targetCounts[3] {
					fmt.Printf("✅ Phase 3 complete: Received %d account updates\n\n", accountCount)
					printFinalStats(totalMessages, slotCount, transactionCount, accountCount)
					cancel()
				}
			}
		}
	}

	// Error handler
	errorHandler := func(err error) {
		if err.Error() != "context canceled" {
			fmt.Printf("Stream error (expected during shutdown): %v\n", err)
		}
	}

	// Start initial subscription
	if err := client.Subscribe(initialRequest, dataHandler, errorHandler); err != nil {
		log.Fatalf("❌ Failed to start initial subscription: %v", err)
	}

	// Wait for completion or signal
	select {
	case <-ctx.Done():
		fmt.Println("🎉 All stream.write tests completed successfully!")
	case <-sigChan:
		fmt.Println("Received interrupt signal, shutting down...")
		cancel()
	}
}

func transitionToPhase2(client *laserstream.Client) {
	fmt.Println("Test Phase 2: Adding transaction subscription via client.Write")

	// Add transaction subscription
	voteFilter := false
	additionalRequest := &laserstream.SubscribeRequest{
		Transactions: map[string]*laserstream.SubscribeRequestFilterTransactions{
			"all-transactions": {
				Vote:   &voteFilter,
				Failed: &voteFilter, // Don't include failed transactions
			},
		},
	}

	if err := client.Write(additionalRequest); err != nil {
		log.Fatalf("❌ Failed to add transaction subscription: %v", err)
	}

	fmt.Println("✅ Successfully sent transaction subscription request")
}

func transitionToPhase3(client *laserstream.Client) {
	fmt.Println("Test Phase 3: Adding account subscription via client.Write")

	// Add account subscription for popular accounts
	additionalRequest := &laserstream.SubscribeRequest{
		Accounts: map[string]*laserstream.SubscribeRequestFilterAccounts{
			"popular-accounts": {
				Account: []string{
					"11111111111111111111111111111112",            // System Program
					"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token Program
				},
			},
		},
	}

	if err := client.Write(additionalRequest); err != nil {
		log.Fatalf("❌ Failed to add account subscription: %v", err)
	}

	fmt.Println("✅ Successfully sent account subscription request")
}

func printFinalStats(total, slots, transactions, accounts int) {
	fmt.Println("📊 Final statistics:")
	fmt.Printf("  - Total messages: %d\n", total)
	fmt.Printf("  - Slot updates: %d\n", slots)
	fmt.Printf("  - Transactions: %d\n", transactions)
	fmt.Printf("  - Account updates: %d\n", accounts)
	fmt.Println()
}
