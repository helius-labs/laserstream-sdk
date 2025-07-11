package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	laserstream "laserstream-go-client"

	"github.com/joho/godotenv"
)

type RPCRequest struct {
	JSONRPC string        `json:"jsonrpc"`
	ID      int           `json:"id"`
	Method  string        `json:"method"`
	Params  []interface{} `json:"params"`
}

type RPCResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int         `json:"id"`
	Result  interface{} `json:"result"`
	Error   *RPCError   `json:"error,omitempty"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func blockExists(slot uint64) (bool, error) {
	// Get RPC configuration from environment variables
	rpcEndpoint := os.Getenv("BLOCK_RPC_ENDPOINT")
	if rpcEndpoint == "" {
		return true, fmt.Errorf("BLOCK_RPC_ENDPOINT environment variable is required")
	}
	rpcAPIKey := os.Getenv("BLOCK_RPC_API_KEY")
	if rpcAPIKey == "" {
		return true, fmt.Errorf("BLOCK_RPC_API_KEY environment variable is required")
	}

	requestBody := RPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "getBlock",
		Params: []interface{}{
			slot,
			map[string]interface{}{
				"encoding":                       "json",
				"transactionDetails":             "full",
				"rewards":                        false,
				"maxSupportedTransactionVersion": 0,
			},
		},
	}

	jsonBody, err := json.Marshal(requestBody)
	if err != nil {
		return true, fmt.Errorf("failed to marshal request: %w", err)
	}

	url := fmt.Sprintf("%s?api-key=%s", rpcEndpoint, rpcAPIKey)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonBody))
	if err != nil {
		return true, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept-Encoding", "gzip")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("RPC check failed for slot %d: %v", slot, err)
		return true, nil // assume exists to err on side of reporting
	}
	defer resp.Body.Close()

	var rpcResp RPCResponse
	if err := json.NewDecoder(resp.Body).Decode(&rpcResp); err != nil {
		log.Printf("Failed to decode RPC response for slot %d: %v", slot, err)
		return true, nil
	}

	if rpcResp.Error != nil && rpcResp.Error.Code == -32007 {
		// Slot was skipped – no block expected
		return false, nil
	}

	return true, nil
}

func main() {
	log.SetFlags(0)
	log.Println("Starting block integrity test. Subscribing to slots...")

	// Load .env file
	if err := godotenv.Load("../examples/.env"); err != nil {
		log.Printf("Warning: Could not load .env file: %v", err)
	}

	// Get configuration from environment variables
	endpoint := os.Getenv("LASERSTREAM_ENDPOINT")
	if endpoint == "" {
		log.Fatalf("❌ LASERSTREAM_ENDPOINT environment variable is required")
	}
	apiKey := os.Getenv("LASERSTREAM_API_KEY")
	if apiKey == "" {
		log.Fatalf("❌ LASERSTREAM_API_KEY environment variable is required")
	}

	config := laserstream.LaserstreamConfig{
		Endpoint:             endpoint,
		APIKey:               apiKey,
		Insecure:             false,
		MaxReconnectAttempts: nil,
	}

	commitmentLevel := laserstream.CommitmentLevel_PROCESSED
	filterByCommitment := true
	interslotUpdates := false

	subscriptionRequest := &laserstream.SubscribeRequest{
		Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
			"slotSubscribe": {
				FilterByCommitment: &filterByCommitment,
				InterslotUpdates:   &interslotUpdates,
			},
		},
		Commitment: &commitmentLevel,
	}

	client := laserstream.NewClient(config)

	var lastSlotNumber *uint64

	dataCallback := func(data *laserstream.SubscribeUpdate) {
		if slotUpdate, ok := data.UpdateOneof.(*laserstream.SubscribeUpdate_Slot); ok {
			if slotUpdate.Slot != nil {
				currentSlotNumber := slotUpdate.Slot.Slot

				if lastSlotNumber != nil && currentSlotNumber != *lastSlotNumber+1 {
					// Iterate through each gap slot and verify if a block exists
					for missing := *lastSlotNumber + 1; missing < currentSlotNumber; missing++ {
						exists, err := blockExists(missing)
						if err != nil {
							log.Printf("Error checking slot %d: %v", missing, err)
							continue
						}

						if exists {
							log.Printf("ERROR: Missed slot %d – block exists but was not received.", missing)
						} else {
							fmt.Printf("Skipped slot %d (no block produced)\n", missing)
						}
					}
				}

				fmt.Printf("Received slot: %d\n", currentSlotNumber)
				lastSlotNumber = &currentSlotNumber
			} else {
				log.Printf("Received slot update, but slot number is undefined: %+v", slotUpdate)
			}
		}
		// Handle other update types if needed - for now ignore them
	}

	errorCallback := func(err error) {
		log.Printf("Subscription error: %v", err)
	}

	err := client.Subscribe(subscriptionRequest, dataCallback, errorCallback)
	if err != nil {
		log.Fatalf("Failed to subscribe: %v", err)
	}

	log.Println("Subscription started. Waiting for slots...")

	// Handle graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("\nShutting down...")
	client.Close()
	time.Sleep(1 * time.Second)
	log.Println("Block integrity test finished.")
}
