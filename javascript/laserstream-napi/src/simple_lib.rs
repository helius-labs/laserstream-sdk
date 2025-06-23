use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn hello_world() -> String {
    "Hello from NAPI + Tonic!".to_string()
}

#[napi]
pub struct SimpleClient {
    endpoint: String,
}

#[napi]
impl SimpleClient {
    #[napi(constructor)]
    pub fn new(endpoint: String) -> Self {
        Self { endpoint }
    }

    #[napi]
    pub fn get_endpoint(&self) -> String {
        self.endpoint.clone()
    }

    #[napi]
    pub async fn test_connection(&self) -> Result<String> {
        // Simplified test - just return success for now
        Ok(format!("Connected to {}", self.endpoint))
    }
}