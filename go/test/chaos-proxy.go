package main

import (
	"crypto/rand"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/joho/godotenv"
)

const (
	MIN_UP = 20 * time.Second
	MAX_UP = 60 * time.Second
	MIN_DN = 5 * time.Second
	MAX_DN = 30 * time.Second
)

type ChaosProxy struct {
	online bool
	flipAt time.Time
	live   []net.Conn
	mu     sync.Mutex
}

func NewChaosProxy() *ChaosProxy {
	return &ChaosProxy{
		online: true,
		flipAt: time.Now().Add(randomDuration(MIN_UP, MAX_UP)),
		live:   make([]net.Conn, 0),
	}
}

func randomDuration(min, max time.Duration) time.Duration {
	diff := int64(max - min)
	n, _ := rand.Int(rand.Reader, big.NewInt(diff))
	return min + time.Duration(n.Int64())
}

func (cp *ChaosProxy) flip() {
	for {
		time.Sleep(500 * time.Millisecond)

		now := time.Now()
		if now.After(cp.flipAt) {
			cp.mu.Lock()
			cp.online = !cp.online

			status := "OFFLINE"
			if cp.online {
				status = "ONLINE"
			} else {
				// Kill all existing connections
				for _, conn := range cp.live {
					conn.Close()
				}
				cp.live = cp.live[:0]
			}

			log.Printf("[proxy] ⇆  %s", status)

			// Set next flip time
			if cp.online {
				cp.flipAt = now.Add(randomDuration(MIN_UP, MAX_UP))
			} else {
				cp.flipAt = now.Add(randomDuration(MIN_DN, MAX_DN))
			}

			cp.mu.Unlock()
		}
	}
}

func (cp *ChaosProxy) handleConnection(client net.Conn, remoteHost string, remotePort int) {
	defer client.Close()

	cp.mu.Lock()
	if !cp.online {
		cp.mu.Unlock()
		return
	}
	cp.mu.Unlock()

	// Connect to upstream
	upstream, err := net.Dial("tcp", fmt.Sprintf("%s:%d", remoteHost, remotePort))
	if err != nil {
		log.Printf("[proxy] failed to connect upstream: %v", err)
		return
	}
	defer upstream.Close()

	log.Println("[proxy] → upstream connected")

	// Disable Nagle algorithm for better performance
	if tcpClient, ok := client.(*net.TCPConn); ok {
		tcpClient.SetNoDelay(true)
	}
	if tcpUpstream, ok := upstream.(*net.TCPConn); ok {
		tcpUpstream.SetNoDelay(true)
	}

	// Add to live connections for tracking
	cp.mu.Lock()
	cp.live = append(cp.live, client, upstream)
	cp.mu.Unlock()

	// Clean up function
	cleanup := func() {
		cp.mu.Lock()
		defer cp.mu.Unlock()

		// Remove from live connections
		newLive := make([]net.Conn, 0, len(cp.live))
		for _, conn := range cp.live {
			if conn != client && conn != upstream {
				newLive = append(newLive, conn)
			}
		}
		cp.live = newLive
	}
	defer cleanup()

	// Bidirectional copy
	done := make(chan error, 2)

	go func() {
		_, err := io.Copy(upstream, client)
		done <- err
	}()

	go func() {
		_, err := io.Copy(client, upstream)
		done <- err
	}()

	// Wait for either direction to finish
	<-done
}

func (cp *ChaosProxy) start() {
	// Get configuration from environment variables
	localPortStr := os.Getenv("LOCAL_PROXY_PORT")
	if localPortStr == "" {
		log.Fatalf("❌ LOCAL_PROXY_PORT environment variable is required")
	}
	localPort, err := strconv.Atoi(localPortStr)
	if err != nil {
		log.Fatalf("❌ LOCAL_PROXY_PORT must be a valid integer: %v", err)
	}

	remoteHost := os.Getenv("PROXY_ENDPOINT")
	if remoteHost == "" {
		log.Fatalf("❌ PROXY_ENDPOINT environment variable is required")
	}

	remotePortStr := os.Getenv("PROXY_PORT")
	if remotePortStr == "" {
		log.Fatalf("❌ PROXY_PORT environment variable is required")
	}
	remotePort, err := strconv.Atoi(remotePortStr)
	if err != nil {
		log.Fatalf("❌ PROXY_PORT must be a valid integer: %v", err)
	}

	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", localPort))
	if err != nil {
		log.Fatalf("Failed to listen on port %d: %v", localPort, err)
	}
	defer listener.Close()

	log.Printf("[proxy] listening on localhost:%d → %s:%d", localPort, remoteHost, remotePort)

	// Start the chaos flip routine
	go cp.flip()

	for {
		client, err := listener.Accept()
		if err != nil {
			log.Printf("[proxy] failed to accept connection: %v", err)
			continue
		}

		go cp.handleConnection(client, remoteHost, remotePort)
	}
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("Starting Chaos Proxy...")

	// Load .env file
	if err := godotenv.Load("../examples/.env"); err != nil {
		log.Printf("Warning: Could not load .env file: %v", err)
	}

	proxy := NewChaosProxy()
	proxy.start()
}
