package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

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

	// Create custom channel options
	channelOptions := &laserstream.ChannelOptions{
		// Connection timeouts
		ConnectTimeoutSecs:    20, // 20 seconds instead of default 10
		MinConnectTimeoutSecs: 15, // 15 seconds minimum connect timeout

		// Message size limits
		MaxRecvMsgSize: 2 * 1024 * 1024 * 1024, // 2GB instead of default 1GB
		MaxSendMsgSize: 64 * 1024 * 1024,       // 64MB instead of default 32MB

		// Keepalive settings
		KeepaliveTimeSecs:    15, // 15 seconds instead of default 30
		KeepaliveTimeoutSecs: 10, // 10 seconds instead of default 5
		PermitWithoutStream:  true,

		// Window sizes for flow control
		InitialWindowSize:     8 * 1024 * 1024,  // 8MB instead of default 4MB
		InitialConnWindowSize: 16 * 1024 * 1024, // 16MB instead of default 8MB

		// Buffer settings
		WriteBufferSize: 128 * 1024, // 128KB instead of default 64KB
		ReadBufferSize:  128 * 1024, // 128KB read buffer

		// Compression settings
		UseCompression: true, // Enable gzip compression
	}

	// Create client configuration with custom channel options
	maxReconnectAttempts := 5
	config := laserstream.LaserstreamConfig{
		Endpoint:             endpoint,
		APIKey:               apiKey,
		MaxReconnectAttempts: &maxReconnectAttempts,
		ChannelOptions:       channelOptions,
	}

	// Create client
	client := laserstream.NewClient(config)

	// Create a simple slot subscription request
	req := &laserstream.SubscribeRequest{
		Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
			"client": {},
		},
	}

	fmt.Println("Subscribing with custom channel options...")
	fmt.Println("- Connect timeout: 20s")
	fmt.Println("- Max receive message size: 2GB")
	fmt.Println("- Keepalive interval: 15s")
	fmt.Println("- Initial stream window: 8MB")
	fmt.Println("- Write buffer size: 128KB")
	fmt.Println("- Compression: gzip enabled")

	// Data handler
	dataHandler := func(update *laserstream.SubscribeUpdate) {
		switch u := update.UpdateOneof.(type) {
		case *laserstream.SubscribeUpdate_Slot:
			fmt.Printf("Slot update: %d (parent: %d)\n", u.Slot.Slot, u.Slot.Parent)
		default:
			fmt.Printf("Received update: %T\n", u)
		}
	}

	// Error handler
	errorHandler := func(err error) {
		log.Printf("Stream error: %v", err)
	}

	// Subscribe
	if err := client.Subscribe(req, dataHandler, errorHandler); err != nil {
		log.Fatalf("Failed to subscribe: %v", err)
	}

	// Wait for interrupt
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	<-sigChan

	fmt.Println("\nShutting down...")
	client.Unsubscribe()
}
