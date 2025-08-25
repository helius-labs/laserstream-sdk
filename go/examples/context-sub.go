package main

import (
	"context"
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
	if endpoint == "" {
		log.Fatal("LASERSTREAM_PRODUCTION_ENDPOINT required")
	}
	apiKey := os.Getenv("LASERSTREAM_API_KEY")
	if apiKey == "" {
		log.Fatal("LASERSTREAM_PRODUCTION_API_KEY required")
	}

	// replay := false

	clientConfig := laserstream.LaserstreamConfig{
		Endpoint: endpoint,
		APIKey:   apiKey,
		// Replay:   &replay,
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
		if slotUpdate, ok := data.UpdateOneof.(*laserstream.SubscribeUpdate_Slot); ok {
			if slotUpdate.Slot != nil {
				log.Printf("Slot: %d", slotUpdate.Slot.Slot)
				return
			}
		}
		log.Printf("Update: %+v", data)
	}

	errorCallback := func(err error) {
		log.Printf("Error: %v", err)
	}

	// Use a context that cancels on SIGINT/SIGTERM
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := client.SubscribeWithContext(ctx, subscriptionRequest, dataCallback, errorCallback); err != nil {
		log.Fatalf("Failed to subscribe: %v", err)
	}

	// Block until context cancellation (Ctrl+C or SIGTERM)
	<-ctx.Done()
}
