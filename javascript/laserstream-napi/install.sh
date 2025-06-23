#!/bin/bash

echo "🚀 Installing NAPI + Tonic LaserStream Client"
echo "=============================================="

# Check for required tools
echo "📋 Checking prerequisites..."

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 16+ first:"
    echo "   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
    echo "   sudo apt-get install -y nodejs"
    exit 1
fi

echo "✅ Node.js version: $(node --version)"

# Check Rust
if ! command -v rustc &> /dev/null; then
    echo "⚠️  Rust not found. Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source $HOME/.cargo/env
else
    echo "✅ Rust version: $(rustc --version)"
fi

# Check build tools (for Ubuntu/Debian)
if command -v apt-get &> /dev/null; then
    echo "📦 Installing build dependencies..."
    sudo apt-get update
    sudo apt-get install -y build-essential pkg-config libssl-dev protobuf-compiler
fi

# Check build tools (for CentOS/RHEL)
if command -v yum &> /dev/null; then
    echo "📦 Installing build dependencies..."
    sudo yum groupinstall -y "Development Tools"
    sudo yum install -y openssl-devel protobuf-compiler
fi

# Check build tools (for macOS)
if command -v brew &> /dev/null; then
    echo "📦 Installing build dependencies..."
    brew install protobuf
fi

echo "✅ Prerequisites installed successfully!"
echo ""
echo "🔧 Next steps:"
echo "1. Clone or copy the laserstream-napi project to your server"
echo "2. Run: npm install"
echo "3. Run: cargo build --release"
echo "4. Run: ./setup.sh"