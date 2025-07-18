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

	endpoint := os.Getenv("LASERSTREAM_PRODUCTION_ENDPOINT")
	if endpoint == "" {
		log.Fatal("LASERSTREAM_PRODUCTION_ENDPOINT required")
	}
	apiKey := os.Getenv("LASERSTREAM_PRODUCTION_API_KEY")
	if apiKey == "" {
		log.Fatal("LASERSTREAM_PRODUCTION_API_KEY required")
	}

	clientConfig := laserstream.LaserstreamConfig{
		Endpoint: endpoint,
		APIKey:   apiKey,
		
	}

	commitmentLevel := laserstream.CommitmentLevel_PROCESSED
	filterByCommitment := true
	subscriptionRequest := &laserstream.SubscribeRequest{
		Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
			"slot-filter": {
				FilterByCommitment: &filterByCommitment,
			},
		},
		Commitment: &commitmentLevel,
	}

	client := laserstream.NewClient(clientConfig)

	dataCallback := func(data *laserstream.SubscribeUpdate) {
		log.Printf("Slot Update: %+v", data)
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
