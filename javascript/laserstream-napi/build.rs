fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(false)
        .build_client(true)
        .protoc_arg("--experimental_allow_proto3_optional")
        .compile(&["proto/geyser.proto", "proto/solana-storage.proto"], &["proto"])?;
        
    napi_build::setup();
    
    Ok(())
}