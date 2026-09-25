package main

import (
	"context"
	"fmt"
	"log"
	"os"

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

	// The same client can also Subscribe; unary calls use their own connection.
	client := laserstream.NewClient(laserstream.NewLaserstreamConfig(endpoint, apiKey))
	defer client.Close()
	ctx := context.Background()

	slot, err := client.GetSlot(ctx, laserstream.CommitmentLevel_CONFIRMED)
	if err != nil {
		log.Fatalf("GetSlot: %v", err)
	}
	fmt.Println("slot (confirmed): ", slot.Slot)

	height, err := client.GetBlockHeight(ctx)
	if err != nil {
		log.Fatalf("GetBlockHeight: %v", err)
	}
	fmt.Println("block height:     ", height.BlockHeight)

	bh, err := client.GetLatestBlockhash(ctx, laserstream.CommitmentLevel_FINALIZED)
	if err != nil {
		log.Fatalf("GetLatestBlockhash: %v", err)
	}
	fmt.Printf("latest blockhash:  %s (slot %d, last valid height %d)\n", bh.Blockhash, bh.Slot, bh.LastValidBlockHeight)

	valid, err := client.IsBlockhashValid(ctx, bh.Blockhash)
	if err != nil {
		log.Fatalf("IsBlockhashValid: %v", err)
	}
	fmt.Println("blockhash valid:  ", valid.Valid)

	version, err := client.GetVersion(ctx)
	if err != nil {
		log.Fatalf("GetVersion: %v", err)
	}
	fmt.Println("version:          ", version.Version)

	pong, err := client.Ping(ctx, 1)
	if err != nil {
		log.Fatalf("Ping: %v", err)
	}
	fmt.Println("ping:             ", pong.Count)

	replay, err := client.SubscribeReplayInfo(ctx)
	if err != nil {
		log.Fatalf("SubscribeReplayInfo: %v", err)
	}
	if replay.FirstAvailable != nil {
		fmt.Println("replay from slot: ", *replay.FirstAvailable)
	}
}
