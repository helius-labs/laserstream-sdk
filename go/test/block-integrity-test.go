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

	laserstream "github.com/helius-labs/laserstream-sdk/go"

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
		return true, nil
	}
	defer resp.Body.Close()

	var rpcResp RPCResponse
	if err := json.NewDecoder(resp.Body).Decode(&rpcResp); err != nil {
		log.Printf("Failed to decode RPC response for slot %d: %v", slot, err)
		return true, nil
	}

	if rpcResp.Error != nil && rpcResp.Error.Code == -32007 {
		return false, nil
	}

	return true, nil
}

func main() {
	log.SetFlags(0)

	godotenv.Load("../.env")

	endpoint := os.Getenv("LASERSTREAM_ENDPOINT")
	if endpoint == "" {
		endpoint = "localhost:4003" // Default to chaos proxy
	}
	apiKey := os.Getenv("LASERSTREAM_API_KEY")
	if apiKey == "" {
		log.Fatal("LASERSTREAM_API_KEY required")
	}

	config := laserstream.LaserstreamConfig{
		Endpoint: endpoint,
		APIKey:   apiKey,
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
	}

	errorCallback := func(err error) {
		log.Printf("Error: %v", err)
	}

	err := client.Subscribe(subscriptionRequest, dataCallback, errorCallback)
	if err != nil {
		log.Fatalf("Failed to subscribe: %v", err)
	}

	log.Println("Subscription started. Waiting for slots...")

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("Shutting down...")
	client.Close()
	time.Sleep(1 * time.Second)
	log.Println("Block integrity test finished.")
}
