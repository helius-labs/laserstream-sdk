package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"

	laserstream "laserstream-go-client"

	"github.com/joho/godotenv"
)

func main() {
	log.SetFlags(0)
	log.Println("Slot Subscription")

	// Load .env file
	if err := godotenv.Load(); err != nil {
		log.Printf("Warning: Could not load .env file: %v", err)
	}

	// Get configuration from environment variables
	endpoint := os.Getenv("LASERSTREAM_PRODUCTION_ENDPOINT")
	if endpoint == "" {
		log.Fatalf("❌ LASERSTREAM_PRODUCTION_ENDPOINT environment variable is required")
	}
	apiKey := os.Getenv("LASERSTREAM_PRODUCTION_API_KEY")
	if apiKey == "" {
		log.Fatalf("❌ LASERSTREAM_PRODUCTION_API_KEY environment variable is required")
	}

	// Create Laserstream client configuration
	clientConfig := laserstream.LaserstreamConfig{
		Endpoint:             endpoint,
		APIKey:               apiKey,
		Insecure:             false,
		MaxReconnectAttempts: nil, // Use default
	}

	// Create subscription request for slots
	commitmentLevel := laserstream.CommitmentLevel_PROCESSED
	subscriptionRequest := &laserstream.SubscribeRequest{
		Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
			"all-slots": {}, // Subscribe to all slot updates
		},
		Commitment: &commitmentLevel,
	}

	// Create client
	client := laserstream.NewClient(clientConfig)

	// Data callback to handle slot updates
	dataCallback := func(data *laserstream.SubscribeUpdate) {
		log.Printf("Slot Update: %+v", data)
	}

	// Error callback
	errorCallback := func(err error) {
		log.Printf("❌ Error: %v", err)
	}

	// Start subscription
	err := client.Subscribe(subscriptionRequest, dataCallback, errorCallback)
	if err != nil {
		log.Fatalf("❌ Failed to subscribe: %v", err)
	}

	// Wait for interrupt signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	client.Close()
}
