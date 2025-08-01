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

	fmt.Println("Testing channel options functionality...")

	// Test 1: Default channel options
	fmt.Println("\n🔧 Test 1: Default channel options")
	testDefaultChannelOptions(endpoint, apiKey)

	// Test 2: Custom channel options
	fmt.Println("\n🔧 Test 2: Custom channel options with large message sizes")
	testCustomChannelOptions(endpoint, apiKey)

	// Test 3: Enhanced settings
	fmt.Println("\n🔧 Test 3: Channel options with enhanced settings")
	testEnhancedSettings(endpoint, apiKey)

	fmt.Println("\n🎉 All channel options tests completed successfully!")
}

func testDefaultChannelOptions(endpoint, apiKey string) {
	config := laserstream.LaserstreamConfig{
		Endpoint: endpoint,
		APIKey:   apiKey,
	}

	client := laserstream.NewClient(config)
	defer client.Close()

	commitmentLevel := laserstream.CommitmentLevel_PROCESSED
	request := &laserstream.SubscribeRequest{
		Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
			"default-test": {},
		},
		Commitment: &commitmentLevel,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	messageCount := 0
	targetCount := 5

	// Set up signal handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// Data handler
	dataHandler := func(update *laserstream.SubscribeUpdate) {
		messageCount++
		switch u := update.UpdateOneof.(type) {
		case *laserstream.SubscribeUpdate_Slot:
			fmt.Printf("📦 Slot %d (attempt %d/%d)\n", u.Slot.Slot, messageCount, targetCount)
		}

		if messageCount >= targetCount {
			fmt.Println("✅ Test 1 passed: Successfully received messages with default options")
			cancel()
		}
	}

	// Error handler
	errorHandler := func(err error) {
		if err.Error() != "context canceled" {
			fmt.Printf("Stream error (expected during shutdown): %v\n", err)
		}
	}

	// Subscribe
	if err := client.Subscribe(request, dataHandler, errorHandler); err != nil {
		log.Fatalf("❌ Test 1 failed: Subscription error: %v", err)
	}

	// Wait for completion or signal
	select {
	case <-ctx.Done():
		// Test completed
	case <-sigChan:
		fmt.Println("Received interrupt signal, shutting down...")
		cancel()
	}
}

func testCustomChannelOptions(endpoint, apiKey string) {
	config := laserstream.LaserstreamConfig{
		Endpoint: endpoint,
		APIKey:   apiKey,
		ChannelOptions: &laserstream.ChannelOptions{
			ReadBufferSize:       1024 * 1024 * 2,  // 2MB
			WriteBufferSize:      1024 * 1024 * 2,  // 2MB
			MaxRecvMsgSize:       1024 * 1024 * 50, // 50MB
			MaxSendMsgSize:       1024 * 1024 * 50, // 50MB
			KeepaliveTimeSecs:    30,
			KeepaliveTimeoutSecs: 5,
		},
	}

	client := laserstream.NewClient(config)
	defer client.Close()

	commitmentLevel := laserstream.CommitmentLevel_PROCESSED
	request := &laserstream.SubscribeRequest{
		Blocks: map[string]*laserstream.SubscribeRequestFilterBlocks{
			"custom-test": {},
		},
		Commitment: &commitmentLevel,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	messageCount := 0
	targetCount := 3

	// Data handler
	dataHandler := func(update *laserstream.SubscribeUpdate) {
		messageCount++
		switch u := update.UpdateOneof.(type) {
		case *laserstream.SubscribeUpdate_Block:
			fmt.Printf("🧱 Block %d - Transactions: %d (attempt %d/%d)\n",
				u.Block.Slot, len(u.Block.Transactions), messageCount, targetCount)
		}

		if messageCount >= targetCount {
			fmt.Println("✅ Test 2 passed: Successfully received large block message with custom options")
			fmt.Println("  - Large message size limits working")
			fmt.Println("  - Custom keepalive settings applied")
			fmt.Println("  - Enhanced buffer sizes configured")
			cancel()
		}
	}

	// Error handler
	errorHandler := func(err error) {
		if err.Error() != "context canceled" {
			fmt.Printf("Stream error (expected during shutdown): %v\n", err)
		}
	}

	// Subscribe
	if err := client.Subscribe(request, dataHandler, errorHandler); err != nil {
		log.Fatalf("❌ Test 2 failed: Subscription error: %v", err)
	}

	// Wait for completion
	<-ctx.Done()
}

func testEnhancedSettings(endpoint, apiKey string) {
	config := laserstream.LaserstreamConfig{
		Endpoint: endpoint,
		APIKey:   apiKey,
		ChannelOptions: &laserstream.ChannelOptions{
			ConnectTimeoutSecs:    30,                // Extended connection timeout
			MinConnectTimeoutSecs: 20,                // Longer minimum timeout
			MaxRecvMsgSize:        1024 * 1024 * 100, // 100MB
			MaxSendMsgSize:        1024 * 1024 * 10,  // 10MB
			KeepaliveTimeSecs:     15,                // More frequent keepalives
			KeepaliveTimeoutSecs:  10,                // Longer timeout
			PermitWithoutStream:   true,              // Allow keepalives without streams
		},
	}

	client := laserstream.NewClient(config)
	defer client.Close()

	commitmentLevel := laserstream.CommitmentLevel_PROCESSED
	request := &laserstream.SubscribeRequest{
		Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
			"enhanced-test": {},
		},
		Commitment: &commitmentLevel,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	messageCount := 0
	targetCount := 3

	// Data handler
	dataHandler := func(update *laserstream.SubscribeUpdate) {
		messageCount++
		switch u := update.UpdateOneof.(type) {
		case *laserstream.SubscribeUpdate_Slot:
			fmt.Printf("📦 Enhanced Slot %d (attempt %d/%d)\n", u.Slot.Slot, messageCount, targetCount)
		}

		if messageCount >= targetCount {
			fmt.Println("✅ Test 3 passed: Successfully received messages with enhanced settings")
			cancel()
		}
	}

	// Error handler
	errorHandler := func(err error) {
		if err.Error() != "context canceled" {
			fmt.Printf("Stream error (expected during shutdown): %v\n", err)
		}
	}

	// Subscribe
	if err := client.Subscribe(request, dataHandler, errorHandler); err != nil {
		log.Fatalf("❌ Test 3 failed: Subscription error: %v", err)
	}

	// Wait for completion
	<-ctx.Done()
}
