const { helloWorld, SimpleClient } = require('./laserstream-napi.node');

console.log('🦀 NAPI Module Test');
console.log('Hello:', helloWorld());

const client = new SimpleClient('https://test-endpoint.com');
console.log('Endpoint:', client.getEndpoint());

client.testConnection().then(result => {
    console.log('Connection test:', result);
}).catch(err => {
    console.error('Error:', err);
});