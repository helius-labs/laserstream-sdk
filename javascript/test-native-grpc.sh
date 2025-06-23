#!/bin/bash

echo "Testing native gRPC performance..."
echo "================================="

# Check if grpc is installed
if ! npm list grpc > /dev/null 2>&1; then
    echo "Installing native grpc package..."
    echo "This requires a C++ compiler and may take a few minutes..."
    npm install grpc@1.24.11 --save-dev
fi

# Run the test
echo ""
echo "Running native gRPC client..."
node examples/grpc-native-real.js