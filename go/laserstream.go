package laserstream

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	pb "github.com/rpcpool/yellowstone-grpc/examples/golang/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// Constants for reconnect logic
const (
	HardCapReconnectAttempts = 240  // 20 minutes / 5 seconds = 240 attempts
	FixedReconnectIntervalMs = 5000 // 5 seconds fixed interval
	ForkDepthSafetyMargin    = 31   // Max fork depth for processed commitment
)

// Commitment levels
const (
	CommitmentProcessed = 0
	CommitmentConfirmed = 1
	CommitmentFinalized = 2
)

// LaserstreamConfig holds the configuration for the client.
type LaserstreamConfig struct {
	Endpoint             string
	APIKey               string
	Insecure             bool
	MaxReconnectAttempts *int // nil uses default (240 attempts)
}

// DataCallback defines the function signature for handling received data.
type DataCallback func(data *SubscribeUpdate)

// ErrorCallback defines the function signature for handling errors.
type ErrorCallback func(err error)

// Client manages the connection and subscription to Laserstream.
type Client struct {
	config        LaserstreamConfig
	conn          *grpc.ClientConn
	stream        pb.Geyser_SubscribeClient
	mu            sync.RWMutex
	cancel        context.CancelFunc
	running       bool
	dataCallback  DataCallback
	errorCallback ErrorCallback

	// Enhanced slot tracking
	trackedSlot  uint64
	madeProgress uint64 // atomic bool (0/1)

	// Request management
	originalRequest   *SubscribeRequest
	internalSlotSubID string
	commitmentLevel   int32
}

// NewClient creates a new Laserstream client instance.
func NewClient(config LaserstreamConfig) *Client {
	return &Client{
		config: config,
	}
}

// Subscribe initiates a subscription to the Laserstream service.
func (c *Client) Subscribe(
	req *SubscribeRequest,
	dataCallback DataCallback,
	errorCallback ErrorCallback,
) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.running {
		return fmt.Errorf("client is already subscribed")
	}

	// Clone the original request
	c.originalRequest = proto.Clone(req).(*SubscribeRequest)
	c.dataCallback = dataCallback
	c.errorCallback = errorCallback

	// Extract commitment level for reconnection logic
	c.commitmentLevel = CommitmentProcessed
	if req.Commitment != nil {
		c.commitmentLevel = int32(*req.Commitment)
	}

	// Generate unique internal slot subscription ID
	c.internalSlotSubID = fmt.Sprintf("__internal_slot_tracker_%s", strings.ReplaceAll(uuid.New().String(), "-", "")[:8])

	// Add internal slot subscription for tracking (will be filtered out)
	if c.originalRequest.Slots == nil {
		c.originalRequest.Slots = make(map[string]*SubscribeRequestFilterSlots)
	}

	filterByCommitment := true
	interslotUpdates := false
	c.originalRequest.Slots[c.internalSlotSubID] = &SubscribeRequestFilterSlots{
		FilterByCommitment: &filterByCommitment,
		InterslotUpdates:   &interslotUpdates,
	}

	ctx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel
	c.running = true

	// Start the connection and streaming loop
	go c.streamLoop(ctx)

	return nil
}

// Close terminates the subscription and closes the connection.
func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.cancel != nil {
		c.cancel()
		c.cancel = nil
	}

	c.cleanup()
	c.running = false
}

// streamLoop handles the main streaming logic with enhanced reconnection
func (c *Client) streamLoop(ctx context.Context) {
	defer func() {
		c.mu.Lock()
		c.cleanup()
		c.running = false
		c.mu.Unlock()
	}()

	reconnectAttempts := uint32(0)

	// Determine effective max attempts
	maxAttempts := HardCapReconnectAttempts
	if c.config.MaxReconnectAttempts != nil {
		if *c.config.MaxReconnectAttempts < maxAttempts {
			maxAttempts = *c.config.MaxReconnectAttempts
		}
	}

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Reset progress flag for this connection attempt
		atomic.StoreUint64(&c.madeProgress, 0)

		// Attempt connection and streaming
		err := c.connectAndStream(ctx)

		if err != nil {
			// Always increment reconnect attempts first
			reconnectAttempts++

			// If we made progress, reset attempts to 1 (this is the first attempt after progress)
			if atomic.LoadUint64(&c.madeProgress) != 0 {
				reconnectAttempts = 1
			}

			// Report the error
			if c.errorCallback != nil {
				errorMsg := fmt.Sprintf("Connection error (attempt %d): %v", reconnectAttempts, err)
				c.errorCallback(fmt.Errorf(errorMsg))
			}

			// Check if exceeded max reconnect attempts
			if reconnectAttempts >= uint32(maxAttempts) {
				if c.errorCallback != nil {
					finalErr := fmt.Sprintf("Connection failed after %d attempts", maxAttempts)
					c.errorCallback(fmt.Errorf(finalErr))
				}
				return
			}

			// Update request with from_slot for reconnection
			c.updateRequestForReconnection()

			// Wait before next attempt
			select {
			case <-time.After(time.Duration(FixedReconnectIntervalMs) * time.Millisecond):
				continue
			case <-ctx.Done():
				return
			}
		} else {
			// Connection ended gracefully, reset attempts
			reconnectAttempts = 0
		}
	}
}

// connectAndStream establishes connection and handles streaming
func (c *Client) connectAndStream(ctx context.Context) error {
	// Connect to gRPC service
	if err := c.connect(ctx); err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}

	// Create gRPC client and stream
	geyserClient := pb.NewGeyserClient(c.conn)

	streamCtx := ctx
	if c.config.APIKey != "" {
		md := metadata.New(map[string]string{"x-token": c.config.APIKey})
		streamCtx = metadata.NewOutgoingContext(streamCtx, md)
	}

	stream, err := geyserClient.Subscribe(streamCtx)
	if err != nil {
		c.cleanup()
		return fmt.Errorf("failed to create stream: %w", err)
	}

	// Send subscription request
	if err := stream.Send(c.originalRequest); err != nil {
		stream.CloseSend()
		c.cleanup()
		return fmt.Errorf("failed to send subscription request: %w", err)
	}

	c.mu.Lock()
	c.stream = stream
	c.mu.Unlock()

	// Handle streaming messages
	return c.handleStream(ctx, stream)
}

// handleStream processes messages from the stream
func (c *Client) handleStream(ctx context.Context, stream pb.Geyser_SubscribeClient) error {
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		resp, err := stream.Recv()
		if err != nil {
			if err == io.EOF {
				return fmt.Errorf("stream ended")
			}

			st, ok := status.FromError(err)
			if ok && (st.Code() == codes.Unavailable || st.Code() == codes.DeadlineExceeded) {
				return fmt.Errorf("stream unavailable: %w", err)
			}

			return fmt.Errorf("stream error: %w", err)
		}

		// Handle ping/pong for connection health
		if pingUpdate, ok := resp.UpdateOneof.(*pb.SubscribeUpdate_Ping); ok {
			if pingUpdate.Ping != nil {
				// Respond with pong
				pongReq := &SubscribeRequest{
					Ping: &SubscribeRequestPing{Id: 1},
				}
				if err := stream.Send(pongReq); err != nil {
					return fmt.Errorf("failed to send pong: %w", err)
				}
			}
			continue
		}

		// Track slot updates for reconnection
		if slotUpdate, ok := resp.UpdateOneof.(*pb.SubscribeUpdate_Slot); ok {
			if slotUpdate.Slot != nil {
				atomic.StoreUint64(&c.trackedSlot, slotUpdate.Slot.Slot)

				// Check if this slot update is EXCLUSIVELY from our internal subscription
				if len(resp.Filters) == 1 && resp.Filters[0] == c.internalSlotSubID {
					continue // Skip forwarding this message
				}
			}
		}

		// Clean up internal filter ID from ALL message types
		cleanedFilters := make([]string, 0, len(resp.Filters))
		for _, filter := range resp.Filters {
			if filter != c.internalSlotSubID {
				cleanedFilters = append(cleanedFilters, filter)
			}
		}
		resp.Filters = cleanedFilters

		// Mark that at least one message was forwarded in this session
		atomic.StoreUint64(&c.madeProgress, 1)

		// Forward to user callback
		if c.dataCallback != nil {
			c.dataCallback(resp)
		}
	}
}

// updateRequestForReconnection updates the request with from_slot for reconnection
func (c *Client) updateRequestForReconnection() {
	lastTrackedSlot := atomic.LoadUint64(&c.trackedSlot)

	if lastTrackedSlot > 0 {
		var fromSlot uint64

		// Determine where to resume based on commitment level
		switch c.commitmentLevel {
		case CommitmentProcessed:
			// Processed – always rewind by 31 slots for fork safety
			if lastTrackedSlot > ForkDepthSafetyMargin {
				fromSlot = lastTrackedSlot - ForkDepthSafetyMargin
			} else {
				fromSlot = 0
			}
		case CommitmentConfirmed, CommitmentFinalized:
			// Confirmed/Finalized – resume exactly at tracked slot
			fromSlot = lastTrackedSlot
		default:
			// Default to processed behavior
			if lastTrackedSlot > ForkDepthSafetyMargin {
				fromSlot = lastTrackedSlot - ForkDepthSafetyMargin
			} else {
				fromSlot = 0
			}
		}

		c.originalRequest.FromSlot = &fromSlot
	} else {
		c.originalRequest.FromSlot = nil
	}
}

// connect establishes a gRPC connection
func (c *Client) connect(ctx context.Context) error {
	c.cleanup()

	endpoint := c.config.Endpoint
	u, err := url.Parse(endpoint)
	if err != nil {
		return fmt.Errorf("error parsing endpoint: %w", err)
	}

	// Use port 443 for gRPC
	target := u.Hostname() + ":443"

	var opts []grpc.DialOption
	if c.config.Insecure {
		opts = append(opts, grpc.WithTransportCredentials(insecure.NewCredentials()))
	} else {
		creds := credentials.NewClientTLSFromCert(nil, "")
		opts = append(opts, grpc.WithTransportCredentials(creds))
	}

	// Enhanced keepalive parameters
	opts = append(opts, grpc.WithKeepaliveParams(keepalive.ClientParameters{
		Time:                30 * time.Second,
		Timeout:             5 * time.Second,
		PermitWithoutStream: true,
	}))

	conn, err := grpc.DialContext(ctx, target, opts...)
	if err != nil {
		return fmt.Errorf("failed to dial: %w", err)
	}

	c.conn = conn
	return nil
}

// cleanup closes connections and streams
func (c *Client) cleanup() {
	if c.stream != nil {
		c.stream.CloseSend()
		c.stream = nil
	}
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
}

// Re-export protobuf types so customers don't need to import yellowstone-grpc directly

// Main request and response types
type (
	SubscribeRequest = pb.SubscribeRequest
	SubscribeUpdate  = pb.SubscribeUpdate
)

// Commitment levels - re-export enum values
const (
	CommitmentLevel_PROCESSED = pb.CommitmentLevel_PROCESSED
	CommitmentLevel_CONFIRMED = pb.CommitmentLevel_CONFIRMED
	CommitmentLevel_FINALIZED = pb.CommitmentLevel_FINALIZED
)

// CommitmentLevel type
type CommitmentLevel = pb.CommitmentLevel

// Filter types for different subscription types
type (
	SubscribeRequestFilterTransactions = pb.SubscribeRequestFilterTransactions
	SubscribeRequestFilterSlots        = pb.SubscribeRequestFilterSlots
	SubscribeRequestFilterAccounts     = pb.SubscribeRequestFilterAccounts
	SubscribeRequestFilterBlocks       = pb.SubscribeRequestFilterBlocks
	SubscribeRequestFilterBlocksMeta   = pb.SubscribeRequestFilterBlocksMeta
	SubscribeRequestFilterEntry        = pb.SubscribeRequestFilterEntry
)

// Additional request types
type (
	SubscribeRequestAccountsDataSlice = pb.SubscribeRequestAccountsDataSlice
	SubscribeRequestPing              = pb.SubscribeRequestPing
)

// Account filter types for more advanced filtering
type (
	SubscribeRequestFilterAccountsFilter         = pb.SubscribeRequestFilterAccountsFilter
	SubscribeRequestFilterAccountsFilterMemcmp   = pb.SubscribeRequestFilterAccountsFilterMemcmp
	SubscribeRequestFilterAccountsFilterLamports = pb.SubscribeRequestFilterAccountsFilterLamports
)

// All SubscribeUpdate variant types for pattern matching
type (
	SubscribeUpdate_Account           = pb.SubscribeUpdate_Account
	SubscribeUpdate_Slot              = pb.SubscribeUpdate_Slot
	SubscribeUpdate_Transaction       = pb.SubscribeUpdate_Transaction
	SubscribeUpdate_TransactionStatus = pb.SubscribeUpdate_TransactionStatus
	SubscribeUpdate_Block             = pb.SubscribeUpdate_Block
	SubscribeUpdate_BlockMeta         = pb.SubscribeUpdate_BlockMeta
	SubscribeUpdate_Entry             = pb.SubscribeUpdate_Entry
	SubscribeUpdate_Ping              = pb.SubscribeUpdate_Ping
	SubscribeUpdate_Pong              = pb.SubscribeUpdate_Pong
)

// Individual update data types
type (
	SubscribeUpdateAccount           = pb.SubscribeUpdateAccount
	SubscribeUpdateSlot              = pb.SubscribeUpdateSlot
	SubscribeUpdateTransaction       = pb.SubscribeUpdateTransaction
	SubscribeUpdateTransactionStatus = pb.SubscribeUpdateTransactionStatus
	SubscribeUpdateBlock             = pb.SubscribeUpdateBlock
	SubscribeUpdateBlockMeta         = pb.SubscribeUpdateBlockMeta
	SubscribeUpdateEntry             = pb.SubscribeUpdateEntry
	SubscribeUpdatePing              = pb.SubscribeUpdatePing
	SubscribeUpdatePong              = pb.SubscribeUpdatePong
)
