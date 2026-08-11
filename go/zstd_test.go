package laserstream

import (
	"bytes"
	"io"
	"testing"

	"google.golang.org/grpc/encoding"
)

func zstdCodec(t *testing.T) encoding.Compressor {
	t.Helper()
	c := encoding.GetCompressor(zstdName)
	if c == nil {
		t.Fatal("zstd compressor is not registered — init() should have registered it")
	}
	return c
}

func roundTrip(t *testing.T, c encoding.Compressor, payload []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w, err := c.Compress(&buf)
	if err != nil {
		t.Fatalf("Compress: %v", err)
	}
	if _, err := w.Write(payload); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	r, err := c.Decompress(&buf)
	if err != nil {
		t.Fatalf("Decompress: %v", err)
	}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	return out
}

func TestZstdRoundTrip(t *testing.T) {
	c := zstdCodec(t)
	for _, payload := range [][]byte{
		{},
		[]byte("hello"),
		bytes.Repeat([]byte("solana block data "), 4096), // compressible, realistic shape
	} {
		if got := roundTrip(t, c, payload); !bytes.Equal(got, payload) {
			t.Fatalf("round trip corrupted a %d-byte payload (got %d bytes)", len(payload), len(got))
		}
	}
}

// NOTE ON THE LEAK: there is deliberately no runtime test for it here.
//
// The leak this implementation replaced (mostynb/go-grpc-compression returning
// its decoder to a pool via a runtime FINALIZER) is a sustained-throughput
// production phenomenon, and attempts to reproduce it in a unit test do not
// work: with WithDecoderLowmem+concurrency 1 the decoders are lazy, so 200
// un-closed decoders move neither HeapAlloc after GC nor the goroutine count.
// A test written against either signal passes whether or not the decoder is
// returned to the pool — verified by removing the pool.Put and watching it
// still pass.
//
// A test that cannot fail is worse than no test, because it reads as coverage.
// What actually guards the regression is the dependency graph: the leaky module
// must not appear in it at all, which is asserted in the consuming service
// (rooms-BE internal/services/laserstream_compression_test.go). The remaining
// verification is real-load memory profiling against a mainnet subscription,
// which no unit test substitutes for.
