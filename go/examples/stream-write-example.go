package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	laserstream "github.com/helius-labs/laserstream-sdk/go"
	"github.com/joho/godotenv"
)

func main() {
	// Get configuration from environment
	godotenv.Load("../.env")

	endpoint := os.Getenv("LASERSTREAM_PRODUCTION_ENDPOINT")
	if endpoint == "" {
		log.Fatal("LASERSTREAM_PRODUCTION_ENDPOINT required")
	}
	apiKey := os.Getenv("LASERSTREAM_PRODUCTION_API_KEY")
	if apiKey == "" {
		log.Fatal("LASERSTREAM_PRODUCTION_API_KEY required")
	}

	// Create client with compression enabled
	channelOptions := &laserstream.ChannelOptions{
		UseCompression: true,
	}

	config := laserstream.LaserstreamConfig{
		Endpoint:       endpoint,
		APIKey:         apiKey,
		ChannelOptions: channelOptions,
	}

	// Create client
	client := laserstream.NewClient(config)
	commitmentLevel := laserstream.CommitmentLevel_FINALIZED

	// Initial subscription request - just subscribe to slots
	initialReq := &laserstream.SubscribeRequest{
		Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
			"client": {
				FilterByCommitment: &[]bool{true}[0],
			},
		},
		Commitment: &commitmentLevel,
	}

	fmt.Println("🚀 Laserstream Bidirectional Stream Example")
	fmt.Println("📡 Starting initial subscription to slots...")

	var messageCount int32
	var transactionAdded atomic.Bool
	var blockAdded atomic.Bool

	// Data handler
	dataHandler := func(update *laserstream.SubscribeUpdate) {
		count := atomic.AddInt32(&messageCount, 1)

		switch u := update.UpdateOneof.(type) {
		case *laserstream.SubscribeUpdate_Slot:
			fmt.Printf("🎰 Slot update #%d: %d\n", count, u.Slot.Slot)

			// After receiving 5 slot updates, add a transaction subscription
			if count == 5 && transactionAdded.CompareAndSwap(false, true) {
				fmt.Println("\n📝 Adding transaction subscription after 5 slots...")

				transactionReq := &laserstream.SubscribeRequest{
					Transactions: map[string]*laserstream.SubscribeRequestFilterTransactions{
						"client": {
							Vote:   &[]bool{false}[0],
							Failed: &[]bool{false}[0],
						},
					},
				}

				if err := client.Write(transactionReq); err != nil {
					fmt.Printf("❌ Failed to add transaction subscription: %v\n", err)
				} else {
					fmt.Println("✅ Successfully added transaction subscription")
				}
			}

		case *laserstream.SubscribeUpdate_Transaction:
			fmt.Printf("💸 Transaction update: %s\n", u.Transaction.Transaction.Signature)

			// After receiving some transactions, add a block subscription
			if count >= 15 && blockAdded.CompareAndSwap(false, true) {
				fmt.Println("\n📦 Adding block subscription...")

				blockReq := &laserstream.SubscribeRequest{
					Blocks: map[string]*laserstream.SubscribeRequestFilterBlocks{
						"client": {
							IncludeTransactions: &[]bool{true}[0],
							IncludeAccounts:     &[]bool{false}[0],
							IncludeEntries:      &[]bool{false}[0],
						},
					},
				}

				if err := client.Write(blockReq); err != nil {
					fmt.Printf("❌ Failed to add block subscription: %v\n", err)
				} else {
					fmt.Println("✅ Successfully added block subscription")
				}
			}

		case *laserstream.SubscribeUpdate_Block:
			txCount := 0
			if u.Block.Transactions != nil {
				txCount = len(u.Block.Transactions)
			}
			fmt.Printf("📦 Block update: slot %d, %d transactions\n", u.Block.Slot, txCount)

		default:
			fmt.Printf("📦 Received update: %T\n", u)
		}

		// Stop after 25 messages
		if count >= 25 {
			fmt.Println("\n🛑 Received 25 messages, shutting down...")
			client.Unsubscribe()
			os.Exit(0)
		}
	}

	// Error handler
	errorHandler := func(err error) {
		log.Printf("Stream error: %v", err)
	}

	// Subscribe
	if err := client.Subscribe(initialReq, dataHandler, errorHandler); err != nil {
		log.Fatalf("Failed to subscribe: %v", err)
	}

	fmt.Println("✅ Stream started successfully")

	// Wait for interrupt
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	// Add a timeout to demonstrate the feature
	go func() {
		time.Sleep(60 * time.Second)
		fmt.Println("\n⏰ Timeout reached, shutting down...")
		sigChan <- syscall.SIGTERM
	}()

	<-sigChan

	fmt.Println("\n🛑 Shutting down...")
	client.Unsubscribe()
}
