package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	laserstream "laserstream-go-client"

	"github.com/joho/godotenv"
)

type FilterTracker struct {
	mu sync.Mutex

	leakedInternalFilter bool
	receivedSlotUpdate   bool
	receivedOtherUpdate  bool
	totalUpdates         int
	internalFilterCount  int
	userFilterMissing    int
}

func (ft *FilterTracker) checkUpdate(update *laserstream.SubscribeUpdate, userSlotFilterID string) {
	ft.mu.Lock()
	defer ft.mu.Unlock()

	ft.totalUpdates++

	for _, filter := range update.Filters {
		if strings.HasPrefix(filter, "__internal_slot_tracker_") {
			log.Printf("ERROR: Internal filter leaked: %v", update.Filters)
			ft.leakedInternalFilter = true
			ft.internalFilterCount++
		}
	}

	if slotUpdate, ok := update.UpdateOneof.(*laserstream.SubscribeUpdate_Slot); ok && slotUpdate.Slot != nil {
		ft.receivedSlotUpdate = true

		hasUserFilter := false
		for _, filter := range update.Filters {
			if filter == userSlotFilterID {
				hasUserFilter = true
				break
			}
		}

		if !hasUserFilter {
			log.Printf("ERROR: Slot update missing user filter. Expected: %s, Got: %v", userSlotFilterID, update.Filters)
			ft.userFilterMissing++
		}
	} else if update.UpdateOneof != nil {
		ft.receivedOtherUpdate = true
	}
}

func (ft *FilterTracker) printSummary() {
	ft.mu.Lock()
	defer ft.mu.Unlock()

	log.Printf("Updates: %d, Slot: %v, Internal leaked: %d, Missing filter: %d, Passed: %v",
		ft.totalUpdates, ft.receivedSlotUpdate, ft.internalFilterCount, ft.userFilterMissing,
		!ft.leakedInternalFilter && ft.receivedSlotUpdate && ft.userFilterMissing == 0)
}

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

	config := laserstream.LaserstreamConfig{
		Endpoint: endpoint,
		APIKey:   apiKey,
		Insecure: false,
	}

	userSlotFilterID := "user-slot-test"
	userTxFilterID := "user-tx-test"
	userBlockFilterID := "user-block-test"

	commitmentLevel := laserstream.CommitmentLevel_PROCESSED
	filterByCommitment := true
	interslotUpdates := false
	voteFilter := true
	failedFilter := false

	subscriptionRequest := &laserstream.SubscribeRequest{
		Slots: map[string]*laserstream.SubscribeRequestFilterSlots{
			userSlotFilterID: {
				FilterByCommitment: &filterByCommitment,
				InterslotUpdates:   &interslotUpdates,
			},
		},
		Transactions: map[string]*laserstream.SubscribeRequestFilterTransactions{
			userTxFilterID: {
				Vote:   &voteFilter,
				Failed: &failedFilter,
			},
		},
		Blocks: map[string]*laserstream.SubscribeRequestFilterBlocks{
			userBlockFilterID: {},
		},
		Commitment: &commitmentLevel,
	}

	tracker := &FilterTracker{}
	client := laserstream.NewClient(config)

	dataCallback := func(data *laserstream.SubscribeUpdate) {
		tracker.checkUpdate(data, userSlotFilterID)
	}

	errorCallback := func(err error) {
		log.Printf("Error: %v", err)
	}

	err := client.Subscribe(subscriptionRequest, dataCallback, errorCallback)
	if err != nil {
		log.Fatalf("Failed to subscribe: %v", err)
	}

	timer := time.NewTimer(10 * time.Second)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	select {
	case <-timer.C:
		log.Println("Test complete")
	case <-sigChan:
		log.Println("Interrupted")
	}

	client.Close()
	time.Sleep(500 * time.Millisecond)

	tracker.printSummary()

	tracker.mu.Lock()
	defer tracker.mu.Unlock()

	if !tracker.receivedSlotUpdate {
		log.Println("FAIL: No slot updates received")
		os.Exit(1)
	}

	if tracker.leakedInternalFilter {
		log.Println("FAIL: Internal filter leaked")
		os.Exit(1)
	}

	if tracker.userFilterMissing > 0 {
		log.Println("FAIL: User filter missing")
		os.Exit(1)
	}

	log.Println("PASS: Test successful")
	fmt.Printf("   - %d updates, no leaks, filters preserved\n", tracker.totalUpdates)
}
