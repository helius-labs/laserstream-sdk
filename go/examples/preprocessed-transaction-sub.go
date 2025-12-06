package main

import (
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"syscall"

	laserstream "github.com/helius-labs/laserstream-sdk/go"
	pb "github.com/helius-labs/laserstream-sdk/go/proto"

	"github.com/joho/godotenv"
)

func main() {
	log.SetFlags(0)

	godotenv.Load("../.env")

	endpoint := os.Getenv("LASERSTREAM_ENDPOINT")
	if endpoint == "" {
		endpoint = "https://laserstream-mainnet-ewr.helius-rpc.com"
	}

	apiKey := os.Getenv("LASERSTREAM_PRODUCTION_API_KEY")
	if apiKey == "" {
		log.Fatal("LASERSTREAM_PRODUCTION_API_KEY must be set")
	}

	log.Println("Subscribing to preprocessed transactions...")

	clientConfig := laserstream.LaserstreamConfig{
		Endpoint: endpoint,
		APIKey:   apiKey,
	}

	voteFilter := false
	subscriptionRequest := &pb.SubscribePreprocessedRequest{
		Transactions: map[string]*pb.SubscribePreprocessedRequestFilterTransactions{
			"preprocessed-filter": {
				Vote: &voteFilter,
			},
		},
	}

	client := laserstream.NewPreprocessedClient(clientConfig)

	dataCallback := func(data *pb.SubscribePreprocessedUpdate) {
		// Convert to JSON for pretty printing
		jsonData, err := json.MarshalIndent(data, "", "  ")
		if err != nil {
			log.Printf("Failed to marshal data: %v", err)
			return
		}
		log.Println(string(jsonData))
	}

	errorCallback := func(err error) {
		log.Printf("Error: %v", err)
	}

	err := client.Subscribe(subscriptionRequest, dataCallback, errorCallback)
	if err != nil {
		log.Fatalf("Failed to subscribe: %v", err)
	}

	log.Println("Successfully subscribed. Listening for preprocessed transactions...")
	log.Println("Press Ctrl+C to exit")

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("\nShutting down...")
	client.Close()
}
