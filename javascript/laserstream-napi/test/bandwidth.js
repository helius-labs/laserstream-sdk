const LaserStream = require('../index');

async function runBandwidthTest() {
    const endpoint = process.env.ENDPOINT || 'https://yellowstone.rpcpool.com';
    const token = process.env.TOKEN;

    if (!token) {
        console.error('Please set TOKEN environment variable');
        process.exit(1);
    }

    console.log('🚀 Starting NAPI + Tonic Bandwidth Test');
    console.log(`📡 Endpoint: ${endpoint}`);
    console.log(`🔑 Token: ${token.substring(0, 10)}...`);
    console.log('');

    const client = new LaserStream(endpoint, token);

    let messageCount = 0;
    let totalBytes = 0;
    let startTime = Date.now();
    let lastReportTime = startTime;
    let lastMessageCount = 0;
    let lastTotalBytes = 0;

    try {
        // Subscribe to all data types for maximum bandwidth
        const handle = await client.subscribeAll(
            (buffer) => {
                messageCount++;
                totalBytes += buffer.length;
            },
            (error) => {
                console.error('❌ Stream error:', error);
            }
        );

        console.log(`✅ Connected, stream ID: ${handle.id}`);
        console.log('📊 Starting bandwidth measurement...\n');

        // Report metrics every second
        const metricsInterval = setInterval(() => {
            const now = Date.now();
            const elapsed = (now - lastReportTime) / 1000;
            const totalElapsed = (now - startTime) / 1000;

            // Calculate rates
            const messagesPerSec = (messageCount - lastMessageCount) / elapsed;
            const bytesPerSec = (totalBytes - lastTotalBytes) / elapsed;
            const avgMessagesPerSec = messageCount / totalElapsed;
            const avgBytesPerSec = totalBytes / totalElapsed;

            // Native metrics
            const nativeMetrics = client.getMetrics();
            const streamMetrics = handle.metrics;

            console.log('═══════════════════════════════════════════════════════');
            console.log(`⏱️  Time: ${totalElapsed.toFixed(1)}s`);
            console.log('');
            
            console.log('📈 Current (1s window):');
            console.log(`   Messages/sec: ${messagesPerSec.toFixed(0)}`);
            console.log(`   MB/sec:       ${(bytesPerSec / 1024 / 1024).toFixed(2)}`);
            console.log(`   Bandwidth:    ${(bytesPerSec * 8 / 1024 / 1024).toFixed(2)} Mbps`);
            console.log('');
            
            console.log('📊 Average:');
            console.log(`   Messages/sec: ${avgMessagesPerSec.toFixed(0)}`);
            console.log(`   MB/sec:       ${(avgBytesPerSec / 1024 / 1024).toFixed(2)}`);
            console.log(`   Bandwidth:    ${(avgBytesPerSec * 8 / 1024 / 1024).toFixed(2)} Mbps`);
            console.log('');
            
            console.log('🏆 Totals:');
            console.log(`   Messages:     ${messageCount.toLocaleString()}`);
            console.log(`   Bytes:        ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
            console.log('');
            
            console.log('🦀 Native Metrics:');
            console.log(`   Active Streams:   ${nativeMetrics.activeStreams}`);
            console.log(`   Msgs/sec:         ${streamMetrics.messagesPerSec.toFixed(0)}`);
            console.log(`   MB/sec:           ${(streamMetrics.bytesPerSec / 1024 / 1024).toFixed(2)}`);
            console.log(`   Avg Latency:      ${streamMetrics.avgLatencyMs.toFixed(2)}ms`);

            // Update for next iteration
            lastReportTime = now;
            lastMessageCount = messageCount;
            lastTotalBytes = totalBytes;
        }, 1000);

        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\n🛑 Shutting down...');
            clearInterval(metricsInterval);
            
            const finalElapsed = (Date.now() - startTime) / 1000;
            const finalAvgMessagesPerSec = messageCount / finalElapsed;
            const finalAvgBytesPerSec = totalBytes / finalElapsed;
            
            console.log('\n📋 Final Results:');
            console.log(`   Duration:         ${finalElapsed.toFixed(1)}s`);
            console.log(`   Total Messages:   ${messageCount.toLocaleString()}`);
            console.log(`   Total Data:       ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
            console.log(`   Avg Messages/sec: ${finalAvgMessagesPerSec.toFixed(0)}`);
            console.log(`   Avg MB/sec:       ${(finalAvgBytesPerSec / 1024 / 1024).toFixed(2)}`);
            console.log(`   Avg Bandwidth:    ${(finalAvgBytesPerSec * 8 / 1024 / 1024).toFixed(2)} Mbps`);
            
            await client.close();
            process.exit(0);
        });

        // Keep running
        await new Promise(() => {});

    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

// Run the test
runBandwidthTest().catch(console.error);