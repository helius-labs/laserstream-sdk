import Laserstream from '../index';
import dotenv from 'dotenv';

dotenv.config();

const endpoint = process.env.LASERSTREAM_ENDPOINT;
const apiKey = process.env.LASERSTREAM_API_KEY;

if (!endpoint || !apiKey) {
    console.error('Please set LASERSTREAM_ENDPOINT and LASERSTREAM_API_KEY environment variables');
    process.exit(1);
}

async function testStreamWrite() {
    console.log('Testing stream.write functionality...\n');

    const config = {
        apiKey: apiKey!,
        endpoint: endpoint!,
    };

    // Initial request - subscribe to slots only
    const initialRequest = {
        slots: {
            'slots-only': {
                filterByCommitment: true,
            }
        }
    };

    const { subscribe } = new Laserstream();
    
    let slotCount = 0;
    let transactionCount = 0;
    let accountCount = 0;
    let totalMessages = 0;
    let testPhase = 1;

    console.log('Test Phase 1: Starting with slots subscription only');

    const stream = await subscribe(config, initialRequest, async (update) => {
        totalMessages++;

        if (update.slot) {
            slotCount++;
        } else if (update.transaction) {
            transactionCount++;
        } else if (update.account) {
            accountCount++;
        }

        // Phase 1: After 5 slot updates, add transaction subscription
        if (testPhase === 1 && slotCount >= 5) {
            testPhase = 2;
            console.log(`✅ Phase 1 complete: Received ${slotCount} slot updates`);
            console.log('\nTest Phase 2: Adding transaction subscription via stream.write');
            
            try {
                stream.write({
                    transactions: {
                        'tx-sub': {
                            vote: false,
                            failed: false,
                            accountInclude: [],
                            accountExclude: [],
                            accountRequired: [],
                        }
                    }
                });
                console.log('✅ Successfully sent transaction subscription request');
            } catch (error) {
                console.error('❌ Failed to write transaction subscription:', error);
                await stream.close();
                process.exit(1);
            }
        }

        // Phase 2: After receiving some transactions, add account subscription
        if (testPhase === 2 && transactionCount >= 5) {
            testPhase = 3;
            console.log(`✅ Phase 2 complete: Received ${transactionCount} transactions`);
            console.log('\nTest Phase 3: Adding account subscription via stream.write');
            
            try {
                // Add token program accounts
                stream.write({
                    accounts: {
                        'token-accounts': {
                            account: [],
                            owner: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
                            filters: []
                        }
                    }
                });
                console.log('✅ Successfully sent account subscription request');
            } catch (error) {
                console.error('❌ Failed to write account subscription:', error);
                await stream.close();
                process.exit(1);
            }
        }

        // Phase 3: After receiving some accounts, complete the test
        if (testPhase === 3 && accountCount >= 5) {
            console.log(`✅ Phase 3 complete: Received ${accountCount} account updates`);
            console.log('\n📊 Final statistics:');
            console.log(`  - Total messages: ${totalMessages}`);
            console.log(`  - Slot updates: ${slotCount}`);
            console.log(`  - Transactions: ${transactionCount}`);
            console.log(`  - Account updates: ${accountCount}`);
            console.log('\n🎉 All stream.write tests passed!');
            
            await stream.close();
            process.exit(0);
        }

        // Timeout after too many messages
        if (totalMessages > 1000) {
            console.error('❌ Test timeout: Received too many messages without completing all phases');
            console.log(`Current state - Phase: ${testPhase}, Slots: ${slotCount}, Txs: ${transactionCount}, Accounts: ${accountCount}`);
            await stream.close();
            process.exit(1);
        }
    });

    // Also set a global timeout
    setTimeout(async () => {
        console.error('❌ Test timeout: Did not complete within 60 seconds');
        console.log(`Final state - Phase: ${testPhase}, Slots: ${slotCount}, Txs: ${transactionCount}, Accounts: ${accountCount}`);
        await stream.close();
        process.exit(1);
    }, 60000);
}

// Run the test
testStreamWrite().catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
});