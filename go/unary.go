package laserstream

import (
	"context"
	"fmt"
	"time"

	pb "github.com/helius-labs/laserstream-sdk/go/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

// DefaultUnaryTimeout applies to unary calls whose context has no deadline.
const DefaultUnaryTimeout = 30 * time.Second

// Unary request/response types.
type (
	GetSlotResponse             = pb.GetSlotResponse
	GetBlockHeightResponse      = pb.GetBlockHeightResponse
	GetLatestBlockhashResponse  = pb.GetLatestBlockhashResponse
	IsBlockhashValidResponse    = pb.IsBlockhashValidResponse
	GetVersionResponse          = pb.GetVersionResponse
	PongResponse                = pb.PongResponse
	SubscribeReplayInfoResponse = pb.SubscribeReplayInfoResponse
)

// unaryClient returns a Geyser client on the shared unary connection, creating
// the connection on first use. The connection is independent of any active
// subscription, so unary calls work with or without Subscribe.
func (c *Client) unaryClient() (pb.GeyserClient, error) {
	c.unaryMu.Lock()
	defer c.unaryMu.Unlock()

	if c.unaryConn == nil {
		target, opts, err := dialConfig(c.config)
		if err != nil {
			return nil, err
		}
		// grpc.NewClient does not block; it connects on the first RPC and
		// reconnects transparently afterwards.
		conn, err := grpc.NewClient(target, opts...)
		if err != nil {
			return nil, fmt.Errorf("failed to create unary connection: %w", err)
		}
		c.unaryConn = conn
	}
	return pb.NewGeyserClient(c.unaryConn), nil
}

func (c *Client) closeUnary() {
	c.unaryMu.Lock()
	defer c.unaryMu.Unlock()
	if c.unaryConn != nil {
		c.unaryConn.Close()
		c.unaryConn = nil
	}
}

// unaryCtx attaches auth + SDK metadata and a default deadline if none is set.
func (c *Client) unaryCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	cancel := context.CancelFunc(func() {})
	if _, ok := ctx.Deadline(); !ok {
		ctx, cancel = context.WithTimeout(ctx, DefaultUnaryTimeout)
	}
	kv := []string{"x-sdk-name", SDKName, "x-sdk-version", SDKVersion}
	if c.config.APIKey != "" {
		kv = append(kv, "x-token", c.config.APIKey)
	}
	return metadata.AppendToOutgoingContext(ctx, kv...), cancel
}

func optCommitment(commitment []CommitmentLevel) *CommitmentLevel {
	if len(commitment) == 0 {
		return nil
	}
	c := commitment[0]
	return &c
}

// callUnary runs fn with an authenticated context on the unary connection.
func callUnary[T any](c *Client, ctx context.Context, fn func(context.Context, pb.GeyserClient) (T, error)) (T, error) {
	var zero T
	client, err := c.unaryClient()
	if err != nil {
		return zero, err
	}
	ctx, cancel := c.unaryCtx(ctx)
	defer cancel()
	return fn(ctx, client)
}

// GetSlot returns the current slot. Commitment is optional (server default if omitted):
//
//	resp, err := client.GetSlot(ctx, laserstream.CommitmentLevel_CONFIRMED)
func (c *Client) GetSlot(ctx context.Context, commitment ...CommitmentLevel) (*GetSlotResponse, error) {
	return callUnary(c, ctx, func(ctx context.Context, g pb.GeyserClient) (*GetSlotResponse, error) {
		return g.GetSlot(ctx, &pb.GetSlotRequest{Commitment: optCommitment(commitment)})
	})
}

// GetBlockHeight returns the current block height. Commitment is optional.
func (c *Client) GetBlockHeight(ctx context.Context, commitment ...CommitmentLevel) (*GetBlockHeightResponse, error) {
	return callUnary(c, ctx, func(ctx context.Context, g pb.GeyserClient) (*GetBlockHeightResponse, error) {
		return g.GetBlockHeight(ctx, &pb.GetBlockHeightRequest{Commitment: optCommitment(commitment)})
	})
}

// GetLatestBlockhash returns the latest blockhash, its slot, and last valid
// block height. Commitment is optional.
func (c *Client) GetLatestBlockhash(ctx context.Context, commitment ...CommitmentLevel) (*GetLatestBlockhashResponse, error) {
	return callUnary(c, ctx, func(ctx context.Context, g pb.GeyserClient) (*GetLatestBlockhashResponse, error) {
		return g.GetLatestBlockhash(ctx, &pb.GetLatestBlockhashRequest{Commitment: optCommitment(commitment)})
	})
}

// IsBlockhashValid reports whether a base58 blockhash is still valid. Commitment is optional.
func (c *Client) IsBlockhashValid(ctx context.Context, blockhash string, commitment ...CommitmentLevel) (*IsBlockhashValidResponse, error) {
	return callUnary(c, ctx, func(ctx context.Context, g pb.GeyserClient) (*IsBlockhashValidResponse, error) {
		return g.IsBlockhashValid(ctx, &pb.IsBlockhashValidRequest{Blockhash: blockhash, Commitment: optCommitment(commitment)})
	})
}

// GetVersion returns server version info (JSON string).
func (c *Client) GetVersion(ctx context.Context) (*GetVersionResponse, error) {
	return callUnary(c, ctx, func(ctx context.Context, g pb.GeyserClient) (*GetVersionResponse, error) {
		return g.GetVersion(ctx, &pb.GetVersionRequest{})
	})
}

// Ping performs a round trip; the server echoes count.
func (c *Client) Ping(ctx context.Context, count int32) (*PongResponse, error) {
	return callUnary(c, ctx, func(ctx context.Context, g pb.GeyserClient) (*PongResponse, error) {
		return g.Ping(ctx, &pb.PingRequest{Count: count})
	})
}

// SubscribeReplayInfo returns the oldest slot this endpoint can replay from:
// the smallest usable SubscribeRequest.FromSlot (FirstAvailable is nil if the
// server reports no replay data).
//
// Call it right before subscribing with an explicit FromSlot (the value moves
// forward as old data is evicted). A FromSlot below it may not be servable,
// and the subscription can fail (e.g. OUT_OF_RANGE) instead of streaming.
// Clamp with max(fromSlot, *FirstAvailable) and treat the skipped slots as
// missed.
//
// It only reports this lower bound; it can't detect gaps in storage above it.
// Despite the name, this is a single request/response call, not a stream.
func (c *Client) SubscribeReplayInfo(ctx context.Context) (*SubscribeReplayInfoResponse, error) {
	return callUnary(c, ctx, func(ctx context.Context, g pb.GeyserClient) (*SubscribeReplayInfoResponse, error) {
		return g.SubscribeReplayInfo(ctx, &pb.SubscribeReplayInfoRequest{})
	})
}
