#!/bin/bash

echo "🔧 Setting up LaserStream NAPI Client"
echo "====================================="

# Install Node.js dependencies
echo "📦 Installing Node.js dependencies..."
npm install

# Build the Rust library
echo "🦀 Building Rust NAPI library..."
cargo build --release

# Copy the native library
echo "📂 Setting up native library..."
DYLIB_PATH="$HOME/.cargo/target/release/liblaserstream_napi.dylib"
SO_PATH="$HOME/.cargo/target/release/liblaserstream_napi.so"

if [ -f "$DYLIB_PATH" ]; then
    cp "$DYLIB_PATH" ./laserstream-napi.node
    echo "✅ Copied dylib for macOS"
elif [ -f "$SO_PATH" ]; then
    cp "$SO_PATH" ./laserstream-napi.node
    echo "✅ Copied so for Linux"
else
    echo "❌ Native library not found. Build may have failed."
    exit 1
fi

# Test the installation
echo "🧪 Testing installation..."
if node -e "console.log('✅ NAPI module loads:', !!require('./laserstream-napi.node').helloWorld)" 2>/dev/null; then
    echo "✅ Installation successful!"
else
    echo "❌ Installation test failed"
    exit 1
fi

# Create example configuration
echo "⚙️  Creating example configuration..."
cat > .env.example << EOF
# LaserStream NAPI Configuration
ENDPOINT=https://yellowstone.rpcpool.com
TOKEN=your-auth-token-here

# Optional: For local testing
# ENDPOINT=http://localhost:9090
# TOKEN=
EOF

echo ""
echo "🎉 Setup complete!"
echo ""
echo "📋 Usage:"
echo "1. Copy .env.example to .env and configure your endpoint"
echo "2. Run basic test: node test-bandwidth.js"
echo "3. Run performance comparison: node compare-performance.js"
echo ""
echo "🔗 Quick test:"
echo "   node -e \"console.log(require('./laserstream-napi.node').helloWorld())\""