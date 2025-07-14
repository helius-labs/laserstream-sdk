package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"log"
	"math"
	"os"
	"sync"
	"time"

	laserstream "laserstream-go-client"

	"github.com/joho/godotenv"

	pb "github.com/rpcpool/yellowstone-grpc/examples/golang/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

const (
	PUMP_ADDRESS             = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
	SLOT_LAG                 = 3000
	INTEGRITY_CHECK_INTERVAL = 30 * time.Second
)

type SignatureTracker struct {
	mu sync.RWMutex

	gotLS map[string]bool
	gotYS map[string]bool

	slotLS map[string]string
	slotYS map[string]string

	lsBySlot  map[uint64]map[string]bool
	ysBySlot  map[uint64]map[string]bool
	maxSlotLS uint64
	maxSlotYS uint64

	newLS int
	newYS int
	errLS int
	errYS int

	statusMap map[string]map[string]string
}

func NewSignatureTracker() *SignatureTracker {
	return &SignatureTracker{
		gotLS:     make(map[string]bool),
		gotYS:     make(map[string]bool),
		slotLS:    make(map[string]string),
		slotYS:    make(map[string]string),
		lsBySlot:  make(map[uint64]map[string]bool),
		ysBySlot:  make(map[uint64]map[string]bool),
		statusMap: make(map[string]map[string]string),
	}
}

func (st *SignatureTracker) addLaserstream(sig string, slot uint64) {
	st.mu.Lock()
	defer st.mu.Unlock()

	slotStr := fmt.Sprintf("%d", slot)

	if !st.gotLS[sig] {
		st.gotLS[sig] = true
		st.newLS++
	}

	st.slotLS[sig] = slotStr

	if st.lsBySlot[slot] == nil {
		st.lsBySlot[slot] = make(map[string]bool)
	}
	st.lsBySlot[slot][sig] = true

	if slot > st.maxSlotLS {
		st.maxSlotLS = slot
	}

	if st.statusMap[sig] == nil {
		st.statusMap[sig] = make(map[string]string)
	}
	st.statusMap[sig]["slotLS"] = slotStr
	st.maybePrint(sig)
}

func (st *SignatureTracker) addYellowstone(sig string, slot uint64) {
	st.mu.Lock()
	defer st.mu.Unlock()

	slotStr := fmt.Sprintf("%d", slot)

	if !st.gotYS[sig] {
		st.gotYS[sig] = true
		st.newYS++
	}

	st.slotYS[sig] = slotStr

	if st.ysBySlot[slot] == nil {
		st.ysBySlot[slot] = make(map[string]bool)
	}
	st.ysBySlot[slot][sig] = true

	if slot > st.maxSlotYS {
		st.maxSlotYS = slot
	}

	if st.statusMap[sig] == nil {
		st.statusMap[sig] = make(map[string]string)
	}
	st.statusMap[sig]["slotYS"] = slotStr
	st.maybePrint(sig)
}

func (st *SignatureTracker) maybePrint(sig string) {
	entry := st.statusMap[sig]
	if entry != nil && entry["slotLS"] != "" && entry["slotYS"] != "" {
		log.Printf("MATCH %s LS_slot=%s YS_slot=%s", sig, entry["slotLS"], entry["slotYS"])
		delete(st.statusMap, sig)
	}
}

func (st *SignatureTracker) addError(isLS bool) {
	st.mu.Lock()
	defer st.mu.Unlock()

	if isLS {
		st.errLS++
	} else {
		st.errYS++
	}
}

func (st *SignatureTracker) doIntegrityCheck() {
	st.mu.Lock()
	defer st.mu.Unlock()

	readySlot := uint64(math.Min(float64(st.maxSlotLS), float64(st.maxSlotYS))) - SLOT_LAG

	slotsToProcess := make(map[uint64]bool)
	for slot := range st.lsBySlot {
		if slot <= readySlot {
			slotsToProcess[slot] = true
		}
	}
	for slot := range st.ysBySlot {
		if slot <= readySlot {
			slotsToProcess[slot] = true
		}
	}

	totalMissingLS := 0
	totalMissingYS := 0

	for slot := range slotsToProcess {
		setLS := st.lsBySlot[slot]
		setYS := st.ysBySlot[slot]
		if setLS == nil {
			setLS = make(map[string]bool)
		}
		if setYS == nil {
			setYS = make(map[string]bool)
		}

		var missingLS []string
		var missingYS []string

		for sig := range setYS {
			if !setLS[sig] {
				missingLS = append(missingLS, sig)
			}
		}
		for sig := range setLS {
			if !setYS[sig] {
				missingYS = append(missingYS, sig)
			}
		}

		if len(missingLS) > 0 || len(missingYS) > 0 {
			log.Printf("[INTEGRITY] transaction_mismatch slot=%d missing Laserstream=%d missing Yellowstone=%d",
				slot, len(missingLS), len(missingYS))
			for _, sig := range missingLS {
				log.Printf("SIGNATURE MISSING IN LASERSTREAM %s (YS_slot=%d)", sig, slot)
			}
			for _, sig := range missingYS {
				log.Printf("SIGNATURE MISSING IN YELLOWSTONE %s (LS_slot=%d)", sig, slot)
			}
		}

		totalMissingLS += len(missingLS)
		totalMissingYS += len(missingYS)

		delete(st.lsBySlot, slot)
		delete(st.ysBySlot, slot)
	}

	now := time.Now().Format(time.RFC3339)
	log.Printf("[%s] laserstream+%d yellowstone+%d processedSlots:%d missingLS:%d missingYS:%d LS_errors:%d YS_errors:%d",
		now, st.newLS, st.newYS, len(slotsToProcess), totalMissingLS, totalMissingYS, st.errLS, st.errYS)

	st.newLS = 0
	st.newYS = 0
}

func extractSigAndSlot(update *laserstream.SubscribeUpdate) (string, uint64, bool) {
	if txUpdate, ok := update.UpdateOneof.(*laserstream.SubscribeUpdate_Transaction); ok {
		if txUpdate.Transaction != nil && txUpdate.Transaction.Transaction != nil {
			if len(txUpdate.Transaction.Transaction.Signature) > 0 {
				sig := hex.EncodeToString(txUpdate.Transaction.Transaction.Signature)
				return sig, txUpdate.Transaction.Slot, true
			}
		}
	}
	return "", 0, false
}

func extractSigAndSlotYS(resp *pb.SubscribeUpdate) (string, uint64, bool) {
	if txUpdate, ok := resp.UpdateOneof.(*pb.SubscribeUpdate_Transaction); ok {
		if txUpdate.Transaction != nil && txUpdate.Transaction.Transaction != nil {
			if len(txUpdate.Transaction.Transaction.Signature) > 0 {
				sig := hex.EncodeToString(txUpdate.Transaction.Transaction.Signature)
				return sig, txUpdate.Transaction.Slot, true
			}
		}
	}
	return "", 0, false
}

func startLaserstreamStream(tracker *SignatureTracker) error {
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
		Insecure: true, // localhost connection through chaos proxy
	}

	commitmentLevel := laserstream.CommitmentLevel_CONFIRMED
	voteFilterBool := false
	failedFilterBool := false

	subscriptionRequest := &laserstream.SubscribeRequest{
		Transactions: map[string]*laserstream.SubscribeRequestFilterTransactions{
			"client": {
				AccountInclude: []string{PUMP_ADDRESS},
				Vote:           &voteFilterBool,
				Failed:         &failedFilterBool,
			},
		},
		Commitment: &commitmentLevel,
	}

	client := laserstream.NewClient(config)

	dataCallback := func(data *laserstream.SubscribeUpdate) {
		if sig, slot, ok := extractSigAndSlot(data); ok {
			tracker.addLaserstream(sig, slot)
		}
	}

	errorCallback := func(err error) {
		tracker.addError(true)
		log.Printf("LASERSTREAM error: %v", err)
	}

	return client.Subscribe(subscriptionRequest, dataCallback, errorCallback)
}

func startYellowstoneStream(tracker *SignatureTracker) error {
	endpoint := os.Getenv("YELLOWSTONE_ENDPOINT")
	if endpoint == "" {
		log.Fatal("YELLOWSTONE_ENDPOINT required")
	}
	apiKey := os.Getenv("YELLOWSTONE_API_KEY")
	if apiKey == "" {
		log.Fatal("YELLOWSTONE_API_KEY required")
	}

	conn, err := grpc.Dial(endpoint, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return fmt.Errorf("failed to connect to yellowstone: %w", err)
	}

	client := pb.NewGeyserClient(conn)

	ctx := context.Background()
	md := metadata.New(map[string]string{"x-token": apiKey})
	ctx = metadata.NewOutgoingContext(ctx, md)

	stream, err := client.Subscribe(ctx)
	if err != nil {
		return fmt.Errorf("failed to create yellowstone stream: %w", err)
	}

	pbCommitmentLevel := pb.CommitmentLevel_CONFIRMED
	voteFilterBool := false
	failedFilterBool := false

	subscriptionRequest := &pb.SubscribeRequest{
		Transactions: map[string]*pb.SubscribeRequestFilterTransactions{
			"client": {
				AccountInclude: []string{PUMP_ADDRESS},
				Vote:           &voteFilterBool,
				Failed:         &failedFilterBool,
			},
		},
		Commitment: &pbCommitmentLevel,
	}

	if err := stream.Send(subscriptionRequest); err != nil {
		return fmt.Errorf("failed to send yellowstone subscription: %w", err)
	}

	go func() {
		for {
			resp, err := stream.Recv()
			if err != nil {
				tracker.addError(false)
				log.Printf("YELLOWSTONE stream error: %v", err)
				return
			}

			if sig, slot, ok := extractSigAndSlotYS(resp); ok {
				tracker.addYellowstone(sig, slot)
			}
		}
	}()

	return nil
}

func main() {
	log.SetFlags(0)

	godotenv.Load("../.env")

	tracker := NewSignatureTracker()

	go func() {
		ticker := time.NewTicker(INTEGRITY_CHECK_INTERVAL)
		defer ticker.Stop()
		for range ticker.C {
			tracker.doIntegrityCheck()
		}
	}()

	go func() {
		if err := startLaserstreamStream(tracker); err != nil {
			log.Fatalf("Failed to start Laserstream: %v", err)
		}
	}()

	go func() {
		if err := startYellowstoneStream(tracker); err != nil {
			log.Fatalf("Failed to start Yellowstone: %v", err)
		}
	}()

	log.Println("Both streams started. Running integrity test...")

	select {}
}
