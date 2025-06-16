use crate::{LaserstreamConfig, LaserstreamError};
use async_stream::try_stream;
use futures::TryStreamExt;
use futures_channel::mpsc as futures_mpsc;
use futures_util::{sink::SinkExt, Stream, StreamExt};
use std::{pin::Pin, time::Duration};
use tokio::time::sleep;
use tonic::Status;
use tracing::{error, instrument, warn};
use uuid;
use yellowstone_grpc_client::{ClientTlsConfig, GeyserGrpcClient};
use yellowstone_grpc_proto::geyser::{
    subscribe_update::UpdateOneof, SubscribeRequest, SubscribeRequestFilterSlots,
    SubscribeRequestPing, SubscribeUpdate,
};

const HARD_CAP_RECONNECT_ATTEMPTS: u32 = (20 * 60) / 5; // 20 mins / 5 sec interval
const FIXED_RECONNECT_INTERVAL_MS: u64 = 5000; // 5 seconds fixed interval

/// Establishes a gRPC connection, handles the subscription lifecycle,
/// and provides a stream of updates. Automatically reconnects on failure.
#[instrument(skip(config, request))]
pub fn subscribe(
    config: LaserstreamConfig,
    request: SubscribeRequest,
) -> impl Stream<Item = Result<SubscribeUpdate, LaserstreamError>> {
    try_stream! {
        let mut reconnect_attempts = 0;
        let mut tracked_slot: u64 = 0;
        let mut confirmed_slot: u64 = 0;

        // Determine the effective max reconnect attempts
        let effective_max_attempts = config
            .max_reconnect_attempts
            .unwrap_or(HARD_CAP_RECONNECT_ATTEMPTS) // Default to hard cap if not set
            .min(HARD_CAP_RECONNECT_ATTEMPTS); // Enforce hard cap

        // Keep original request for reconnection attempts
        let current_request = request.clone();
        let internal_slot_sub_id = format!("internal-{}", uuid::Uuid::new_v4().to_string().split('-').next().unwrap());
        
        // Check if user originally had slot subscriptions
        let user_has_slot_subscriptions = !current_request.slots.is_empty();

        let api_key_string = config.api_key.clone(); 

        loop {

            let mut attempt_request = current_request.clone();

            // Ensure our dedicated internal slot subscription is present for tracking purposes
            {
                let confirmed_slot_filter = SubscribeRequestFilterSlots {
                    filter_by_commitment: Some(true),
                    interslot_updates: Some(true),
                    ..Default::default()
                };
                attempt_request.slots.entry(internal_slot_sub_id.clone()).or_insert(confirmed_slot_filter);
            }

            // On reconnection, resume from last confirmed slot if available, else last processed slot
            if reconnect_attempts > 0 {
                let resume_slot = if confirmed_slot > 0 { confirmed_slot } else { tracked_slot };
                if resume_slot > 0 {
                    attempt_request.from_slot = Some(resume_slot);
                }
            }

            match connect_and_subscribe_once(&config, attempt_request, api_key_string.clone()).await { // Pass String API key
                Ok((sender, stream)) => {

                    // Box sender and stream here before processing
                    let mut sender: Pin<Box<dyn futures_util::Sink<SubscribeRequest, Error = futures_mpsc::SendError> + Send>> = Box::pin(sender);
                    // Ensure the boxed stream yields Result<_, tonic::Status>
                    let mut stream: Pin<Box<dyn Stream<Item = Result<SubscribeUpdate, tonic::Status>> + Send>> =
                        Box::pin(stream.map_err(|ystatus| {
                            // Convert yellowstone_grpc_proto::tonic::Status to tonic::Status
                            let code = tonic::Code::from_i32(ystatus.code() as i32);
                            tonic::Status::new(code, ystatus.message())
                        }));

                    while let Some(result) = stream.next().await {
                        match result {
                            Ok(update) => {
                                // Handle ping/pong
                                if matches!(&update.update_oneof, Some(UpdateOneof::Ping(_))) {
                                    let pong_req = SubscribeRequest { ping: Some(SubscribeRequestPing { id: 1 }), ..Default::default() };
                                    if let Err(e) = sender.send(pong_req).await {
                                        warn!(error = %e, "Failed to send pong");
                                        break;
                                    }
                                    continue;
                                }

                                // Handle slot updates - check if our internal slot ID is present
                                if let Some(UpdateOneof::Slot(s)) = &update.update_oneof {
                                    // Always track slots for reconnection purposes
                                    tracked_slot = s.slot;
                                    if s.status == 1 || s.status == 2 {
                                        confirmed_slot = s.slot;
                                    }

                                    // Check if this slot update contains our internal slot ID
                                    if update.filters.contains(&internal_slot_sub_id) {
                                        // If user has slot subscriptions, clean the filters and pass through
                                        if user_has_slot_subscriptions {
                                            // Remove internal slot ID from filters
                                            let user_filters: Vec<String> = update.filters
                                                .iter()
                                                .filter(|&filter_id| filter_id != &internal_slot_sub_id)
                                                .cloned()
                                                .collect();
                                            
                                            if !user_filters.is_empty() {
                                                // Create clean update with only user filter IDs
                                                let mut clean_update = update.clone();
                                                clean_update.filters = user_filters;
                                                yield clean_update;
                                            }
                                        }
                                        // Don't pass purely internal slot updates to user
                                        continue;
                                    }
                                }

                                // For all other updates (non-slot or slot without internal ID):
                                yield update;
                            }
                            Err(status) => {
                                // status is now tonic::Status due to map_err above
                                warn!(error = %status, "Stream error, attempting reconnection");
                            }
                        }
                    }
                    warn!("Stream ended, preparing to reconnect...");
                }
                Err(err) => {
                    // Error from connect_and_subscribe_once (GeyserGrpcClientError)
                    warn!(error = %err, "Failed to connect/subscribe, preparing to reconnect...");
                }
            }

            reconnect_attempts += 1;
            if reconnect_attempts >= effective_max_attempts {
                error!(attempts = effective_max_attempts, config_value = ?config.max_reconnect_attempts, "Max reconnection attempts reached");
                Err(LaserstreamError::MaxReconnectAttempts(Status::cancelled(
                    format!("Max reconnection attempts ({}) reached", effective_max_attempts)
                )))?;
            }

            // Use fixed interval delay, but only after the first failed attempt
            if reconnect_attempts > 1 {
                let delay = Duration::from_millis(FIXED_RECONNECT_INTERVAL_MS);
                sleep(delay).await;
            }
        }
    }
}

#[instrument(skip(config, request, api_key))]
async fn connect_and_subscribe_once(
    config: &LaserstreamConfig,
    request: SubscribeRequest,
    api_key: String,
) -> Result<
    (
        impl futures_util::Sink<SubscribeRequest, Error = futures_mpsc::SendError> + Send,
        impl Stream<Item = Result<SubscribeUpdate, yellowstone_grpc_proto::tonic::Status>> + Send,
    ),
    tonic::Status,
> {
    let mut builder = GeyserGrpcClient::build_from_shared(config.endpoint.clone()) // Use endpoint String directly
        .map_err(|e| tonic::Status::internal(format!("Build client error: {}", e)))?
        .x_token(Some(api_key))
        .map_err(|e| tonic::Status::internal(format!("Set token error: {}", e)))?
        .connect_timeout(Duration::from_secs(10))
        .max_decoding_message_size(1_000_000_000)
        .timeout(Duration::from_secs(10))
        .tls_config(ClientTlsConfig::new().with_enabled_roots())
        .map_err(|e| tonic::Status::internal(format!("TLS config error: {}", e)))?
        .connect()
        .await
        .map_err(|e| tonic::Status::internal(format!("Connect error: {}", e)))?;

    let (sender, stream) = builder
        .subscribe_with_request(Some(request))
        .await
        .map_err(|e| tonic::Status::internal(format!("Subscribe error: {}", e)))?;

    Ok((sender, stream))
}
