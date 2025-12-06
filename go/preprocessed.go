package laserstream

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	pb "github.com/helius-labs/laserstream-sdk/go/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// PreprocessedDataCallback is called for each preprocessed update received from the stream.
type PreprocessedDataCallback func(*pb.SubscribePreprocessedUpdate)

// PreprocessedClient handles preprocessed transaction subscriptions (simple, no slot tracking).
type PreprocessedClient struct {
	config          LaserstreamConfig
	dataCallback    PreprocessedDataCallback
	errorCallback   ErrorCallback
	mu              sync.RWMutex
	cancel          context.CancelFunc
	running         bool
	originalRequest *pb.SubscribePreprocessedRequest
}

// NewPreprocessedClient creates a new preprocessed client with the given configuration.
func NewPreprocessedClient(config LaserstreamConfig) *PreprocessedClient {
	return &PreprocessedClient{
		config: config,
	}
}

// Subscribe initiates a subscription to preprocessed transactions.
func (c *PreprocessedClient) Subscribe(
	req *pb.SubscribePreprocessedRequest,
	dataCallback PreprocessedDataCallback,
	errorCallback ErrorCallback,
) error {
	return c.SubscribeWithContext(context.Background(), req, dataCallback, errorCallback)
}

// SubscribeWithContext initiates a subscription with a custom context.
func (c *PreprocessedClient) SubscribeWithContext(
	ctx context.Context,
	req *pb.SubscribePreprocessedRequest,
	dataCallback PreprocessedDataCallback,
	errorCallback ErrorCallback,
) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.running {
		return fmt.Errorf("client is already subscribed")
	}

	c.originalRequest = req
	c.dataCallback = dataCallback
	c.errorCallback = errorCallback

	ctx, cancel := context.WithCancel(ctx)
	c.cancel = cancel
	c.running = true

	go c.streamLoop(ctx)

	return nil
}

// Close terminates the subscription.
func (c *PreprocessedClient) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.cancel != nil {
		c.cancel()
		c.cancel = nil
	}

	c.running = false
}

// streamLoop handles the main streaming logic with simple reconnection.
func (c *PreprocessedClient) streamLoop(ctx context.Context) {
	reconnectAttempts := 0

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

		err := c.connectAndStream(ctx)

		if err != nil {
			reconnectAttempts++

			fmt.Printf("RECONNECT: Preprocessed connection failed (attempt %d/%d): %v\n", reconnectAttempts, maxAttempts, err)

			if reconnectAttempts >= maxAttempts {
				if c.errorCallback != nil {
					finalErr := fmt.Sprintf("Preprocessed connection failed after %d attempts: %v", maxAttempts, err)
					c.errorCallback(fmt.Errorf("%s", finalErr))
				}
				return
			}

			select {
			case <-time.After(time.Duration(FixedReconnectIntervalMs) * time.Millisecond):
				continue
			case <-ctx.Done():
				return
			}
		}

		// If stream ended gracefully, return
		return
	}
}

// connectAndStream establishes connection and processes the preprocessed stream.
func (c *PreprocessedClient) connectAndStream(ctx context.Context) error {
	// Parse endpoint
	endpoint := c.config.Endpoint
	target := endpoint
	if strings.HasPrefix(endpoint, "https://") || strings.HasPrefix(endpoint, "http://") {
		u, err := url.Parse(endpoint)
		if err != nil {
			return fmt.Errorf("error parsing endpoint URL: %w", err)
		}
		if u.Port() != "" {
			target = u.Host
		} else {
			target = u.Hostname() + ":443"
		}
	}

	// Create connection
	var opts []grpc.DialOption
	creds := credentials.NewClientTLSFromCert(nil, "")
	opts = append(opts, grpc.WithTransportCredentials(creds))

	conn, err := grpc.DialContext(ctx, target, opts...)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	defer conn.Close()

	client := pb.NewGeyserClient(conn)

	// Add SDK metadata and API key to context
	ctx = metadata.AppendToOutgoingContext(ctx,
		"x-sdk-name", SDKName,
		"x-sdk-version", SDKVersion,
		"x-request-id", uuid.NewString(),
		"x-token", c.config.APIKey,
	)

	stream, err := client.SubscribePreprocessed(ctx)
	if err != nil {
		return fmt.Errorf("failed to subscribe: %w", err)
	}

	// Send initial request
	if err := stream.Send(c.originalRequest); err != nil {
		return fmt.Errorf("failed to send initial request: %w", err)
	}

	// Process updates
	for {
		update, err := stream.Recv()
		if err != nil {
			if err == io.EOF {
				// Treat EOF as an error to trigger reconnection
				return fmt.Errorf("stream closed by server (EOF)")
			}

			st, ok := status.FromError(err)
			if ok {
				return fmt.Errorf("stream error: %s", st.Message())
			}

			return fmt.Errorf("recv error: %w", err)
		}

		if c.dataCallback != nil {
			c.dataCallback(update)
		}
	}
}
