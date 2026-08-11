package laserstream

import (
	"bytes"
	"io"
	"sync"

	"github.com/klauspost/compress/zstd"
	"google.golang.org/grpc/encoding"
)

// This file registers the "zstd" gRPC compressor used when a ChannelOption
// requests zstd. It replaces github.com/mostynb/go-grpc-compression, whose
// decoder is returned to a sync.Pool only via a runtime finalizer: under a
// high-throughput LaserStream subscription, decoders (each holding a zstd
// history window) are created faster than finalizers reclaim them, so the
// window buffers accumulate into multi-GB heap growth.
//
// Here every Decompress call gets a decoder from the pool, decodes the whole
// (size-bounded) message with DecodeAll, and returns the decoder to the pool
// before returning — synchronous reclamation, no finalizers, so decoders never
// pile up. The decoder window and decoded size are also bounded.

const zstdName = "zstd"

const (
	// zstdMaxWindow caps the decoder history window. Far above any realistic
	// streaming-RPC frame (well below the 512 MiB klauspost default).
	zstdMaxWindow = 64 << 20 // 64 MiB
	// zstdMaxDecodedSize bounds a single DecodeAll output, guarding against
	// decompression bombs while staying under the default 1 GiB gRPC
	// MaxRecvMsgSize (gRPC enforces the message-size limit on top of this).
	zstdMaxDecodedSize = 512 << 20 // 512 MiB
)

// init registers the compressor. RegisterCompressor must be called from init
// (gRPC requirement); registering for an existing name overrides it (last
// registration wins), so this takes precedence over any other "zstd" provider.
func init() {
	encoding.RegisterCompressor(newZstdCompressor())
}

type zstdCompressor struct {
	encoder *zstd.Encoder
	pool    sync.Pool // holds *zstd.Decoder, used only for DecodeAll
}

func newZstdCompressor() *zstdCompressor {
	// One shared encoder; EncodeAll is safe for concurrent use. Outbound
	// messages are small (subscribe requests), so a 512 KiB window is ample.
	enc, _ := zstd.NewWriter(nil,
		zstd.WithEncoderConcurrency(1),
		zstd.WithWindowSize(512<<10),
	)
	c := &zstdCompressor{encoder: enc}
	c.pool.New = func() any {
		dec, _ := zstd.NewReader(nil,
			zstd.WithDecoderConcurrency(1),
			zstd.WithDecoderLowmem(true),
			zstd.WithDecoderMaxWindow(zstdMaxWindow),
			zstd.WithDecoderMaxMemory(zstdMaxDecodedSize),
		)
		return dec
	}
	return c
}

func (c *zstdCompressor) Name() string { return zstdName }

func (c *zstdCompressor) Compress(w io.Writer) (io.WriteCloser, error) {
	return &zstdWriteCloser{enc: c.encoder, w: w}, nil
}

// zstdWriteCloser buffers the uncompressed message and compresses it in one
// shot on Close (gRPC writes the message, then closes the compressor).
type zstdWriteCloser struct {
	enc *zstd.Encoder
	w   io.Writer
	buf bytes.Buffer
}

func (z *zstdWriteCloser) Write(p []byte) (int, error) { return z.buf.Write(p) }

func (z *zstdWriteCloser) Close() error {
	_, err := z.w.Write(z.enc.EncodeAll(z.buf.Bytes(), nil))
	return err
}

func (c *zstdCompressor) Decompress(r io.Reader) (io.Reader, error) {
	compressed, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	dec := c.pool.Get().(*zstd.Decoder)
	out, err := dec.DecodeAll(compressed, nil)
	c.pool.Put(dec) // reusable regardless of err; return it synchronously
	if err != nil {
		return nil, err
	}
	return bytes.NewReader(out), nil
}
