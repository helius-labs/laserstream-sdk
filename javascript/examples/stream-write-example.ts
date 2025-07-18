import { subscribe, CommitmentLevel, SubscribeUpdate, StreamHandle, LaserstreamConfig, SubscribeRequest } from '../client';
import bs58 from 'bs58';

const credentials = require('../test-config');

async function main() {

  const config: LaserstreamConfig = {
    apiKey: credentials.laserstreamProduction.apiKey,
    endpoint: credentials.laserstreamProduction.endpoint,
  };

  const request = {
    accounts: {
      "all-accounts": {
        account: [],
        owner: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
        filters: []
      }
    },
    commitment: CommitmentLevel.PROCESSED,
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };

  let message = 0;
  // Initial subscription request
  const stream = await subscribe(
    config,
    request,
    async (update: SubscribeUpdate) => {
      message+=1
      if(update.account){
      console.log('🏦 Account Update:', bs58.encode(update.account?.account?.owner))
      }
      console.log(message)
      if(message == 50){
        try{
        stream.write({
          accounts: {
            "all-accounts": {
              account: [],
              owner: ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"],
              filters: []
            }
          }
        })
        }catch(e){
          console.error('❌ Stream error:', e)
        }
      }
    },
    async (err) => console.error('❌ Stream error:', err)
  );

  // stream.cancel();
}

main().catch(console.error);


// import { CommitmentLevel, SubscribeUpdate, SubscribeRequest } from '@triton-one/yellowstone-grpc';

// import Client from '@triton-one/yellowstone-grpc';
// import bs58 from 'bs58';
// import { LaserstreamConfig } from '../client';
// import { write } from 'fs';

// const credentials = require('../test-config');

// async function main() {

//   const client = new Client(credentials.laserstreamProduction.endpoint, credentials.laserstreamProduction.apiKey, undefined);

//     const request: SubscribeRequest = {
//     accounts: {
//       "all-accounts": {
//         account: [],
//         owner: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
//         filters: []
//       }
//     },
//     commitment: CommitmentLevel.PROCESSED,
//     slots: {},
//     transactions: {},
//     transactionsStatus: {},
//     blocks: {},
//     blocksMeta: {},
//     entry: {},
//     accountsDataSlice: [],
//   };

//   let message = 0;
//   // Initial subscription request
//     const stream = await client.subscribe()

//     stream.write(request)

//     stream.on('data', (data) => {
//       console.log('🏦 Data:', data.account?.account?.owner)
//       message+=1
//       if(data.account){
//       console.log('🏦 Account Update:', bs58.encode(data.account?.account?.owner))
//       }
//       console.log(message)
//       if(message == 50){
//         try{
//           stream.write({
//             accounts: {
//               "all-accounts": {
//                 account: [],
//                 owner: ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'],
//                 filters: []
//               }
//             },
//             commitment: CommitmentLevel.PROCESSED,
//             slots: {},
//             transactions: {},
//             transactionsStatus: {},
//             blocks: {},
//             blocksMeta: {},
//             entry: {},
//             accountsDataSlice: []
//           })
//         }catch(e){
//           console.error('❌ Stream error:', e)
//         }
//       }
//     })

//   // stream.cancel();
// }

// main().catch(console.error);
