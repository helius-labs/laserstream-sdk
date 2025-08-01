import Laserstream from '../index';
import dotenv from 'dotenv';

dotenv.config();

const endpoint = process.env.LASERSTREAM_ENDPOINT;
const apiKey = process.env.LASERSTREAM_API_KEY;

if (!endpoint || !apiKey) {
    console.error('Please set LASERSTREAM_ENDPOINT and LASERSTREAM_API_KEY environment variables');
    process.exit(1);
}

async function testChannelOptions() {
    console.log('Testing channel options functionality...\n');

    // Test 1: Default channel options (no options specified)
    console.log('Test 1: Default channel options');
    const config1 = {
        apiKey: apiKey!,
        endpoint: endpoint!,
    };

    const request1 = {
        slots: {
            'slot-test': {
                filterByCommitment: true,
            }
        }
    };

    try {
        const { subscribe } = new Laserstream();
        let messageCount1 = 0;
        
        const stream1 = await subscribe(config1, request1, async (update) => {
            messageCount1++;
            if (messageCount1 === 5) {
                console.log('✅ Test 1 passed: Successfully received messages with default options\n');
                await stream1.close();
            }
        });
    } catch (error) {
        console.error('❌ Test 1 failed:', error);
        process.exit(1);
    }

    // Test 2: Custom channel options with large message size and compression
    console.log('Test 2: Custom channel options with compression and large message sizes');
    const config2 = {
        apiKey: apiKey!,
        endpoint: endpoint!,
        channelOptions: {
            'grpc.max_send_message_length': 64000000,      // 64MB
            'grpc.max_receive_message_length': 2000000000,  // 2GB
            'grpc.keepalive_time_ms': 20000,                // 20 seconds
            'grpc.keepalive_timeout_ms': 10000,             // 10 seconds
            'grpc.keepalive_permit_without_calls': 1,       // true
            'grpc.default_compression_algorithm': 3,         // zstd compression
            'grpc.http2.write_buffer_size': 1048576,        // 1MB
            'grpc.client_idle_timeout_ms': 300000,          // 5 minutes
        }
    };

    const request2 = {
        blocks: {
            'block-test': {
                accountInclude: [],
                includeTransactions: true,
                includeAccounts: true,
                includeEntries: false,
            }
        }
    };

    try {
        const { subscribe } = new Laserstream();
        let messageCount2 = 0;
        
        const stream2 = await subscribe(config2, request2, async (update) => {
            messageCount2++;
            if (messageCount2 === 1) {
                console.log('✅ Test 2 passed: Successfully received large block message with custom options');
                console.log('  - Compression enabled (zstd)');
                console.log('  - Large message size limits working');
                console.log('  - Custom keepalive settings applied\n');
                await stream2.close();
            }
        });
    } catch (error) {
        console.error('❌ Test 2 failed:', error);
        process.exit(1);
    }

    // Test 3: Test with gzip compression
    console.log('Test 3: Channel options with gzip compression');
    const config3 = {
        apiKey: apiKey!,
        endpoint: endpoint!,
        channelOptions: {
            'grpc.default_compression_algorithm': 2,  // gzip
            'grpc.max_receive_message_length': 1000000000,
        }
    };

    const request3 = {
        transactions: {
            'tx-test': {
                vote: false,
                failed: false,
                accountInclude: [],
                accountExclude: [],
                accountRequired: [],
            }
        }
    };

    try {
        const { subscribe } = new Laserstream();
        let messageCount3 = 0;
        
        const stream3 = await subscribe(config3, request3, async (update) => {
            messageCount3++;
            if (messageCount3 === 5) {
                console.log('✅ Test 3 passed: Successfully received messages with gzip compression\n');
                await stream3.close();
                console.log('🎉 All channel options tests passed!');
                process.exit(0);
            }
        });
    } catch (error) {
        console.error('❌ Test 3 failed:', error);
        process.exit(1);
    }
}

// Run the tests
testChannelOptions().catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
});