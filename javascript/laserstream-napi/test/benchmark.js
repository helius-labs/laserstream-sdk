const LaserStream = require('../index');
const OriginalClient = require('../../src/client'); // Original JS implementation

async function runComparison() {
    const endpoint = process.env.ENDPOINT || 'https://yellowstone.rpcpool.com';
    const token = process.env.TOKEN;

    if (!token) {
        console.error('Please set TOKEN environment variable');
        process.exit(1);
    }

    console.log('🏁 NAPI vs Pure JS Benchmark');
    console.log(`📡 Endpoint: ${endpoint}`);
    console.log('');

    const testDuration = 30000; // 30 seconds
    const request = {
        accounts: {},
        transactions: {},
    };

    // Test NAPI implementation
    console.log('🦀 Testing NAPI + Tonic implementation...');
    const napiResults = await runSingleTest(
        () => new LaserStream(endpoint, token),
        request,
        testDuration,
        'NAPI'
    );

    console.log('\n⏳ Waiting 5 seconds between tests...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Test original JS implementation
    console.log('🌐 Testing Pure JS implementation...');
    const jsResults = await runSingleTest(
        () => new OriginalClient(endpoint, token),
        request,
        testDuration,
        'JS'
    );

    // Compare results
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('📊 COMPARISON RESULTS');
    console.log('═══════════════════════════════════════════════════════');
    
    console.log(`NAPI Implementation:`);
    console.log(`  Messages:     ${napiResults.totalMessages.toLocaleString()}`);
    console.log(`  Data:         ${(napiResults.totalBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Msgs/sec:     ${napiResults.avgMessagesPerSec.toFixed(0)}`);
    console.log(`  MB/sec:       ${(napiResults.avgBytesPerSec / 1024 / 1024).toFixed(2)}`);
    console.log(`  Bandwidth:    ${(napiResults.avgBytesPerSec * 8 / 1024 / 1024).toFixed(2)} Mbps`);
    console.log('');
    
    console.log(`Pure JS Implementation:`);
    console.log(`  Messages:     ${jsResults.totalMessages.toLocaleString()}`);
    console.log(`  Data:         ${(jsResults.totalBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Msgs/sec:     ${jsResults.avgMessagesPerSec.toFixed(0)}`);
    console.log(`  MB/sec:       ${(jsResults.avgBytesPerSec / 1024 / 1024).toFixed(2)}`);
    console.log(`  Bandwidth:    ${(jsResults.avgBytesPerSec * 8 / 1024 / 1024).toFixed(2)} Mbps`);
    console.log('');
    
    // Performance improvement
    const msgImprovement = ((napiResults.avgMessagesPerSec - jsResults.avgMessagesPerSec) / jsResults.avgMessagesPerSec * 100);
    const bandwidthImprovement = ((napiResults.avgBytesPerSec - jsResults.avgBytesPerSec) / jsResults.avgBytesPerSec * 100);
    
    console.log(`🚀 Performance Improvement:`);
    console.log(`  Messages/sec: ${msgImprovement > 0 ? '+' : ''}${msgImprovement.toFixed(1)}%`);
    console.log(`  Bandwidth:    ${bandwidthImprovement > 0 ? '+' : ''}${bandwidthImprovement.toFixed(1)}%`);
}

async function runSingleTest(clientFactory, request, duration, label) {
    return new Promise(async (resolve, reject) => {
        let messageCount = 0;
        let totalBytes = 0;
        const startTime = Date.now();

        const client = clientFactory();
        
        try {
            const handle = await client.subscribe(request, (data) => {
                messageCount++;
                totalBytes += Buffer.isBuffer(data) ? data.length : JSON.stringify(data).length;
            });

            console.log(`  ✅ ${label} connected`);

            // Stop after duration
            setTimeout(async () => {
                const elapsed = (Date.now() - startTime) / 1000;
                
                if (typeof handle.cancel === 'function') {
                    handle.cancel();
                } else if (typeof client.close === 'function') {
                    await client.close();
                }

                const results = {
                    totalMessages: messageCount,
                    totalBytes: totalBytes,
                    duration: elapsed,
                    avgMessagesPerSec: messageCount / elapsed,
                    avgBytesPerSec: totalBytes / elapsed
                };

                console.log(`  📊 ${label} Results: ${messageCount.toLocaleString()} msgs, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
                resolve(results);
            }, duration);

        } catch (error) {
            reject(error);
        }
    });
}

// Run benchmark
runComparison().catch(console.error);