const { helloWorld, LaserStreamClient } = require('./laserstream-napi.node');

async function runTests() {
    console.log('🚀 NAPI + Tonic Bandwidth Testing');
    console.log('=' .repeat(50));
    
    // Test 1: Basic functionality
    console.log('\n✅ Test 1: Basic NAPI Functions');
    console.log('Hello World:', helloWorld());
    
    // Test 2: Client initialization
    console.log('\n✅ Test 2: Client Initialization');
    const endpoint = process.env.ENDPOINT || 'https://yellowstone.rpcpool.com';
    const token = process.env.TOKEN || null;
    
    const client = new LaserStreamClient(endpoint, token);
    console.log('Client endpoint:', client.getEndpoint());
    
    // Test 3: Connection test
    console.log('\n✅ Test 3: Connection Test');
    try {
        const result = await client.testConnection();
        console.log('Connection result:', result);
    } catch (error) {
        console.error('Connection failed:', error);
    }
    
    // Test 4: Mock bandwidth test
    console.log('\n✅ Test 4: Mock Bandwidth Test');
    console.log('Running 5-second mock bandwidth test...');
    
    try {
        const result = await client.mockBandwidthTest(5000);
        
        console.log('\n📊 Mock Bandwidth Results:');
        console.log(`Duration:       ${result.durationSeconds.toFixed(2)}s`);
        console.log(`Messages:       ${result.totalMessages.toLocaleString()}`);
        console.log(`Data:           ${(result.totalBytes / 1024 / 1024).toFixed(2)} MB`);
        console.log(`Messages/sec:   ${result.messagesPerSec.toFixed(0)}`);
        console.log(`MB/sec:         ${(result.bytesPerSec / 1024 / 1024).toFixed(2)}`);
        console.log(`Bandwidth:      ${result.bandwidthMbps.toFixed(2)} Mbps`);
        
        // Performance assessment
        console.log('\n🏆 Performance Assessment:');
        if (result.bandwidthMbps > 1000) {
            console.log('🟢 EXCELLENT: >1 Gbps throughput capability');
        } else if (result.bandwidthMbps > 100) {
            console.log('🟡 GOOD: >100 Mbps throughput capability');
        } else {
            console.log('🟠 OK: Basic throughput capability');
        }
        
    } catch (error) {
        console.error('Bandwidth test failed:', error);
    }
    
    console.log('\n✨ Test Suite Complete!');
    console.log('\n📝 Next Steps:');
    console.log('1. Set ENDPOINT and TOKEN environment variables');
    console.log('2. Implement real gRPC streaming for actual testing');
    console.log('3. Compare with pure JavaScript implementation');
}

runTests().catch(console.error);