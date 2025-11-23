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
	"google.golang.org/grpc/backoff"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/encoding/gzip"
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

// SDK metadata constants
const (
	SDKName    = "laserstream-go"
	SDKVersion = "0.0.9"
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
	MaxReconnectAttempts *int            // nil uses default (240 attempts)
	ChannelOptions       *ChannelOptions // nil uses defaults
	Replay               *bool           // nil => default true; set to pointer false to disable
}

// ChannelOptions configures gRPC channel behavior
type ChannelOptions struct {
	// Connection timeouts
	ConnectTimeoutSecs    int // Default: 10
	MinConnectTimeoutSecs int // Default: 10

	// Message size limits
	MaxRecvMsgSize int // Max message size in bytes for receiving. Default: 1GB
	MaxSendMsgSize int // Max message size in bytes for sending. Default: 32MB

	// Keepalive settings
	KeepaliveTimeSecs    int  // Default: 30
	KeepaliveTimeoutSecs int  // Default: 5
	PermitWithoutStream  bool // Default: true

	// Window sizes for flow control
	InitialWindowSize     int32 // Per-stream window size. Default: 4MB
	InitialConnWindowSize int32 // Connection window size. Default: 8MB

	// Buffer settings
	WriteBufferSize int // Default: 64KB
	ReadBufferSize  int // Default: 64KB

	// Compression settings
	UseCompression bool // Enable gzip compression. Default: false
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

	// Bidirectional streaming support
	writeChan     chan *SubscribeRequest
	writeStopChan chan struct{}
}

// NewLaserstreamConfig creates a new LaserstreamConfig with default values.
func NewLaserstreamConfig(endpoint, apiKey string) LaserstreamConfig {
	defaultReplay := true
	return LaserstreamConfig{
		Endpoint: endpoint,
		APIKey:   apiKey,
		Replay:   &defaultReplay,
	}
}

// NewClient creates a new Laserstream client instance.
func NewClient(config LaserstreamConfig) *Client {
	return &Client{
		config:        config,
		writeChan:     make(chan *SubscribeRequest, 100),
		writeStopChan: make(chan struct{}),
	}
}

// isReplayEnabled returns the effective replay setting
func (c *Client) isReplayEnabled() bool {
	if c.config.Replay == nil {
		return true
	}
	return *c.config.Replay
}

// SubscribeWithContext initiates a subscription using the provided context.
// The provided context controls cancellation and deadlines for the stream loop.
func (c *Client) SubscribeWithContext(
	ctx context.Context,
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

	// Add internal slot subscription for tracking only when replay is enabled
	if c.isReplayEnabled() {
		if c.originalRequest.Slots == nil {
			c.originalRequest.Slots = make(map[string]*SubscribeRequestFilterSlots)
		}

		filterByCommitment := true
		interslotUpdates := false
		c.originalRequest.Slots[c.internalSlotSubID] = &SubscribeRequestFilterSlots{
			FilterByCommitment: &filterByCommitment,
			InterslotUpdates:   &interslotUpdates,
		}
	}

	// Clear any user-provided FromSlot if replay is disabled
	if !c.isReplayEnabled() {
		c.originalRequest.FromSlot = nil
	}

	// Derive a cancelable child context so Close()/Unsubscribe() remain effective
	ctx, cancel := context.WithCancel(ctx)
	c.cancel = cancel
	c.running = true

	// Start the connection and streaming loop
	go c.streamLoop(ctx)

	return nil
}

// Subscribe initiates a subscription to the Laserstream service.
// It delegates to SubscribeWithContext using context.Background().
func (c *Client) Subscribe(
	req *SubscribeRequest,
	dataCallback DataCallback,
	errorCallback ErrorCallback,
) error {
	return c.SubscribeWithContext(context.Background(), req, dataCallback, errorCallback)
}

// Write sends a new subscription request to update the active subscription.
// This allows dynamic modification of the subscription filters.
func (c *Client) Write(req *SubscribeRequest) error {
	c.mu.RLock()
	if !c.running {
		c.mu.RUnlock()
		return fmt.Errorf("client is not connected")
	}
	c.mu.RUnlock()

	// Persist the update so reconnects reuse the latest effective subscription.
	c.mu.Lock()
	if c.originalRequest != nil {
		mergeSubscribeRequests(c.originalRequest, req, c.internalSlotSubID)
	}
	c.mu.Unlock()

	select {
	case c.writeChan <- req:
		return nil
	case <-time.After(5 * time.Second):
		return fmt.Errorf("write timeout: channel full")
	}
}

// mergeSubscribeRequests merges an in-flight stream-write update into the cached
// request used for subsequent reconnects. It keeps the internal slot tracker intact.
func mergeSubscribeRequests(base, update *SubscribeRequest, internalSlotID string) {
	if base == nil || update == nil {
		return
	}

	var internalSlot *SubscribeRequestFilterSlots
	if internalSlotID != "" && base.Slots != nil {
		internalSlot = base.Slots[internalSlotID]
	}

	if len(update.Accounts) > 0 {
		if base.Accounts == nil {
			base.Accounts = make(map[string]*SubscribeRequestFilterAccounts)
		}
		for k, v := range update.Accounts {
			base.Accounts[k] = v
		}
	}

	if len(update.Slots) > 0 {
		if base.Slots == nil {
			base.Slots = make(map[string]*SubscribeRequestFilterSlots)
		}
		for k, v := range update.Slots {
			base.Slots[k] = v
		}
	}

	if len(update.Transactions) > 0 {
		if base.Transactions == nil {
			base.Transactions = make(map[string]*SubscribeRequestFilterTransactions)
		}
		for k, v := range update.Transactions {
			base.Transactions[k] = v
		}
	}

	if len(update.TransactionsStatus) > 0 {
		if base.TransactionsStatus == nil {
			base.TransactionsStatus = make(map[string]*SubscribeRequestFilterTransactions)
		}
		for k, v := range update.TransactionsStatus {
			base.TransactionsStatus[k] = v
		}
	}

	if len(update.Blocks) > 0 {
		if base.Blocks == nil {
			base.Blocks = make(map[string]*SubscribeRequestFilterBlocks)
		}
		for k, v := range update.Blocks {
			base.Blocks[k] = v
		}
	}

	if len(update.BlocksMeta) > 0 {
		if base.BlocksMeta == nil {
			base.BlocksMeta = make(map[string]*SubscribeRequestFilterBlocksMeta)
		}
		for k, v := range update.BlocksMeta {
			base.BlocksMeta[k] = v
		}
	}

	if len(update.Entry) > 0 {
		if base.Entry == nil {
			base.Entry = make(map[string]*SubscribeRequestFilterEntry)
		}
		for k, v := range update.Entry {
			base.Entry[k] = v
		}
	}

	if len(update.AccountsDataSlice) > 0 {
		base.AccountsDataSlice = append(base.AccountsDataSlice, update.AccountsDataSlice...)
	}

	if update.Commitment != nil {
		base.Commitment = update.Commitment
	}

	if update.FromSlot != nil {
		base.FromSlot = update.FromSlot
	}

	// Re-apply the internal slot tracker after the merge so it never gets dropped.
	if internalSlotID != "" && internalSlot != nil {
		if base.Slots == nil {
			base.Slots = make(map[string]*SubscribeRequestFilterSlots)
		}
		base.Slots[internalSlotID] = internalSlot
	}
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

			// Log error internally but don't report to consumer until max attempts exhausted
			fmt.Printf("RECONNECT: Connection failed (attempt %d/%d): %v\n", reconnectAttempts, maxAttempts, err)

			// Check if exceeded max reconnect attempts
			if reconnectAttempts >= uint32(maxAttempts) {
				// Only report error to consumer after exhausting all retries
				if c.errorCallback != nil {
					finalErr := fmt.Sprintf("Connection failed after %d attempts: %v", maxAttempts, err)
					c.errorCallback(fmt.Errorf("%s", finalErr))
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
	// Create metadata with SDK information and API key
	md := metadata.New(map[string]string{
		"x-sdk-name":    SDKName,
		"x-sdk-version": SDKVersion,
	})
	if c.config.APIKey != "" {
		md.Set("x-token", c.config.APIKey)
	}
	streamCtx = metadata.NewOutgoingContext(streamCtx, md)

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
	// Start a goroutine to handle write requests
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-c.writeStopChan:
				return
			case req := <-c.writeChan:
				if req != nil {
					if err := stream.Send(req); err != nil {
						if c.errorCallback != nil {
							c.errorCallback(fmt.Errorf("failed to send write request: %w", err))
						}
					}
				}
			}
		}
	}()

	// Start periodic ping goroutine
	pingCtx, cancelPing := context.WithCancel(ctx)
	defer cancelPing()

	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-pingCtx.Done():
				return
			case <-ticker.C:
				pingReq := &SubscribeRequest{
					Ping: &SubscribeRequestPing{
						Id: int32(time.Now().UnixMilli()),
					},
				}
				if err := stream.Send(pingReq); err != nil {
					// If ping fails, let main stream handler deal with reconnection
					return
				}
			}
		}
	}()

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

		// Hide any server-side pong updates from user callbacks
		if _, ok := resp.UpdateOneof.(*pb.SubscribeUpdate_Pong); ok {
			continue
		}

		// Track slot updates for reconnection only when replay is enabled
		if slotUpdate, ok := resp.UpdateOneof.(*pb.SubscribeUpdate_Slot); ok {
			if slotUpdate.Slot != nil && c.isReplayEnabled() {
				atomic.StoreUint64(&c.trackedSlot, slotUpdate.Slot.Slot)
			}

			// Check if this slot update is EXCLUSIVELY from our internal subscription
			if c.isReplayEnabled() && len(resp.Filters) == 1 && resp.Filters[0] == c.internalSlotSubID {
				continue // Skip forwarding this message
			}
		}

		// Also track slots from block updates when replay is enabled (for cases where no slot subscription exists)
		if blockUpdate, ok := resp.UpdateOneof.(*pb.SubscribeUpdate_Block); ok {
			if blockUpdate.Block != nil && c.isReplayEnabled() {
				atomic.StoreUint64(&c.trackedSlot, blockUpdate.Block.Slot)
			}
		}

		// Clean up internal filter ID from ALL message types (only when replay is enabled)
		if c.isReplayEnabled() {
			cleanedFilters := make([]string, 0, len(resp.Filters))
			for _, filter := range resp.Filters {
				if filter != c.internalSlotSubID {
					cleanedFilters = append(cleanedFilters, filter)
				}
			}
			resp.Filters = cleanedFilters
		}

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
	// Only use from_slot when replay is enabled
	if !c.isReplayEnabled() {
		c.originalRequest.FromSlot = nil
		return
	}

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

	// Handle production endpoint formats
	var target string
	if strings.HasPrefix(endpoint, "https://") || strings.HasPrefix(endpoint, "http://") {
		// URL format (e.g., https://example.com or https://example.com:443)
		u, err := url.Parse(endpoint)
		if err != nil {
			return fmt.Errorf("error parsing endpoint URL: %w", err)
		}

		// Always use TLS and default HTTPS port
		if u.Port() != "" {
			target = u.Host
		} else {
			target = u.Hostname() + ":443"
		}
	} else {
		// Simple host:port format (e.g., localhost:4003, example.com:80, example.com)
		if strings.Contains(endpoint, ":") {
			// Already has port
			target = endpoint
		} else {
			// No port, add default 443
			target = endpoint + ":443"
		}
	}

	var opts []grpc.DialOption
	creds := credentials.NewClientTLSFromCert(nil, "")
	opts = append(opts, grpc.WithTransportCredentials(creds))

	// Apply channel options with defaults
	channelOpts := c.config.ChannelOptions
	if channelOpts == nil {
		channelOpts = &ChannelOptions{} // Use all defaults
	}

	// Keepalive parameters
	keepaliveTime := 30 * time.Second
	keepaliveTimeout := 5 * time.Second
	permitWithoutStream := true

	if channelOpts.KeepaliveTimeSecs > 0 {
		keepaliveTime = time.Duration(channelOpts.KeepaliveTimeSecs) * time.Second
	}
	if channelOpts.KeepaliveTimeoutSecs > 0 {
		keepaliveTimeout = time.Duration(channelOpts.KeepaliveTimeoutSecs) * time.Second
	}
	permitWithoutStream = channelOpts.PermitWithoutStream

	opts = append(opts, grpc.WithKeepaliveParams(keepalive.ClientParameters{
		Time:                keepaliveTime,
		Timeout:             keepaliveTimeout,
		PermitWithoutStream: permitWithoutStream,
	}))

	// Message size limits
	maxRecvMsgSize := 1024 * 1024 * 1024 // 1GB default
	maxSendMsgSize := 32 * 1024 * 1024   // 32MB default

	if channelOpts.MaxRecvMsgSize > 0 {
		maxRecvMsgSize = channelOpts.MaxRecvMsgSize
	}
	if channelOpts.MaxSendMsgSize > 0 {
		maxSendMsgSize = channelOpts.MaxSendMsgSize
	}

	// Configure default call options
	callOpts := []grpc.CallOption{
		grpc.MaxCallRecvMsgSize(maxRecvMsgSize),
		grpc.MaxCallSendMsgSize(maxSendMsgSize),
	}

	// Add compression if enabled
	if channelOpts.UseCompression {
		callOpts = append(callOpts, grpc.UseCompressor(gzip.Name))
	}

	opts = append(opts, grpc.WithDefaultCallOptions(callOpts...))

	// Connection parameters
	minConnectTimeout := 10 * time.Second
	if channelOpts.MinConnectTimeoutSecs > 0 {
		minConnectTimeout = time.Duration(channelOpts.MinConnectTimeoutSecs) * time.Second
	}

	opts = append(opts, grpc.WithConnectParams(grpc.ConnectParams{
		Backoff:           backoff.DefaultConfig,
		MinConnectTimeout: minConnectTimeout,
	}))

	// Window sizes
	if channelOpts.InitialWindowSize > 0 {
		opts = append(opts, grpc.WithInitialWindowSize(channelOpts.InitialWindowSize))
	} else {
		opts = append(opts, grpc.WithInitialWindowSize(4*1024*1024)) // 4MB default
	}

	if channelOpts.InitialConnWindowSize > 0 {
		opts = append(opts, grpc.WithInitialConnWindowSize(channelOpts.InitialConnWindowSize))
	} else {
		opts = append(opts, grpc.WithInitialConnWindowSize(8*1024*1024)) // 8MB default
	}

	// Buffer sizes
	if channelOpts.WriteBufferSize > 0 {
		opts = append(opts, grpc.WithWriteBufferSize(channelOpts.WriteBufferSize))
	} else {
		opts = append(opts, grpc.WithWriteBufferSize(64*1024)) // 64KB default
	}

	if channelOpts.ReadBufferSize > 0 {
		opts = append(opts, grpc.WithReadBufferSize(channelOpts.ReadBufferSize))
	}

	conn, err := grpc.DialContext(ctx, target, opts...)
	if err != nil {
		return fmt.Errorf("failed to dial: %w", err)
	}

	c.conn = conn
	return nil
}

// Unsubscribe closes the stream and cleans up resources
func (c *Client) Unsubscribe() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.cancel != nil {
		c.cancel()
		c.cancel = nil
	}

	c.cleanup()
	c.running = false
}

// cleanup closes connections and streams
func (c *Client) cleanup() {
	// Signal write goroutine to stop
	select {
	case c.writeStopChan <- struct{}{}:
	default:
	}

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
	SubscribeRequestFilterAccountsFilter          = pb.SubscribeRequestFilterAccountsFilter
	SubscribeRequestFilterAccountsFilterMemcmp    = pb.SubscribeRequestFilterAccountsFilterMemcmp
	SubscribeRequestFilterAccountsFilterLamports  = pb.SubscribeRequestFilterAccountsFilterLamports
	SubscribeRequestFilterAccountsFilter_Datasize = pb.SubscribeRequestFilterAccountsFilter_Datasize
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
