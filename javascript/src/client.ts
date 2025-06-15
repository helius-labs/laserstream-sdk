/**
 * LaserStreamClient provides a wrapper around Yellowstone gRPC
 * with automatic reconnection and slot tracking
 */

import Client, { SubscribeUpdate } from "@triton-one/yellowstone-grpc";
import {  LaserstreamConfig, SubscribeRequest } from "./types";

// Default values for reconnection parameters
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 240; // 20 minutes / 5 seconds = 240 attempts
const FIXED_RECONNECT_INTERVAL_MS = 5000; // 5 seconds fixed interval

/**
 * Internal state tracking for subscription management and reconnection
 */
interface State {
  config: LaserstreamConfig;
  reconnectAttempts: number;
  trackedSlot: number;      // last processed slot observed
  confirmedSlot: number;    // last slot whose status is >= CONFIRMED
  subscription: SubscribeRequest;
  onData: (data: SubscribeUpdate) => void;
  onError: (error: Error) => void;
  internalSlotId: string;   // id of internal tracking subscription
}

/**
 * Creates a subscription to LaserStream
 * 
 * @param config - LaserStream configuration with API key and endpoint
 * @param subscriptionRequest - The subscription configuration. Use subscriptionRequest.fromSlot to specify initial starting point
 * @param onData - Callback for received data
 * @param onError - Callback for errors
 * @returns The subscription object that can be used to manage the connection
 */
export async function subscribe(
  config: LaserstreamConfig,
  subscriptionRequest: SubscribeRequest,
  onData: (data: SubscribeUpdate) => void,
  onError: (error: Error) => void,
) {
  return subscribeWithReplayTracking(
    config,
    subscriptionRequest,
    onData,
    onError,
    0 // Initial reconnect attempts
  );
}

/**
 * Internal function that handles subscription with replay tracking and reconnection attempts.
 * This function maintains the last known slot position to enable replay from the correct point after disconnection.
 * 
 * The slot tracking works in two ways:
 * 1. Initial subscription: Uses fromSlot from subscriptionRequest if provided
 * 2. Reconnection: Uses the last tracked slot number to resume from where we left off
 * 
 * @param config - LaserStream configuration with API key and endpoint
 * @param subscriptionRequest - The subscription configuration
 * @param onData - Callback for received data
 * @param onError - Callback for errors
 * @param reconnectAttempts - Number of reconnection attempts made so far
 * @returns The subscription object that can be used to manage the connection
 */
async function subscribeWithReplayTracking(
  config: LaserstreamConfig,
  subscriptionRequest: SubscribeRequest,
  onData: (data: SubscribeUpdate) => void,
  onError: (error: Error) => void,
  reconnectAttempts = 0
) {
  // Initialize client with proper message size limit
  const client = new Client(config.endpoint, config.apiKey, {
    "grpc.max_receive_message_length": 64 * 1024 * 1024 // 64MB message size limit
  });

  try {
    // Create subscription to the gRPC service
    const subscription = await client.subscribe();
    
    // Initialize internal state for tracking and reconnection
    const state: State = {
      config,
      reconnectAttempts,
      // On initial connection, use fromSlot from request if provided, otherwise start from 0
      trackedSlot: subscriptionRequest.fromSlot ? parseInt(subscriptionRequest.fromSlot) : 0,
      confirmedSlot: 0,
      subscription: subscriptionRequest,
      onData,
      onError,
      internalSlotId: Math.random().toString(36).substring(2, 15)
    };

    // Ensure we have a slot subscription for tracking purposes
    if (!subscriptionRequest.slots) {
      subscriptionRequest.slots = {};
    }
    subscriptionRequest.slots[state.internalSlotId] = {
      filterByCommitment: true,
      interslotUpdates: true
    };

    // On reconnection attempts, always use the last tracked slot to ensure we resume from where we left off
    if (state.reconnectAttempts > 0 && state.confirmedSlot > 0) {
      subscriptionRequest.fromSlot = state.confirmedSlot.toString();
    }

    // Set up handlers for various stream lifecycle events
    const streamClosed = new Promise<void>((resolve) => {
      // Handle stream errors and trigger reconnection
      subscription.on("error", (error) => {
        console.error("Stream error:", error);
        handleReconnection(state, error);
        resolve();
      });
      
      subscription.on("end", () => {
        resolve();
      });
      
      subscription.on("close", () => {
        resolve();
      });
    });

    // Error handling for unexpected stream closure
    streamClosed.catch(() => {
      // Error-based reconnection is now handled in the error listener directly
    });

    // Send subscription request to the server
    try {
      await new Promise<void>((resolve, reject) => {
        subscription.write(subscriptionRequest, (err: Error | null | undefined) => {
          if (err === null || err === undefined) {
            resolve();
          } else {
            reject(err);
          }
        });
      });
    } catch (error: any) {
      onError(new Error('Failed to write subscription request: ' + error.message));
      throw error;
    }

    // Set up data handler
    subscription.on('data', (data) => {
      if (data.slot) {
        const slotNumber = parseInt(data.slot.slot);
        state.trackedSlot = slotNumber;

        const st = (data.slot as any).status as number | string | undefined;
        if (st === 1 || st === 2 || st === 'CONFIRMED' || st === 'FINALIZED') {
          state.confirmedSlot = slotNumber;
        }
      }

      // Reset reconnect attempts on any successful message
      state.reconnectAttempts = 0;

      onData(data);
    });

    return subscription;
  } catch (error: any) {
    onError(new Error('Failed to establish subscription: ' + error.message));
    throw error;
  }
}

/**
 * Handles reconnection logic with exponential backoff
 * 
 * @param state - The current subscription state
 * @param error - The error that triggered the reconnection attempt
 */
function handleReconnection(state: State, error: Error) {
  const maxAttempts = state.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;

  // Use the configured max attempts, but ensure it doesn't exceed the hard limit (20 mins / 5s)
  const effectiveMaxAttempts = Math.min(maxAttempts, DEFAULT_MAX_RECONNECT_ATTEMPTS);

  if (state.reconnectAttempts >= effectiveMaxAttempts) {
    state.onError(new Error(`Max reconnection attempts (${effectiveMaxAttempts}) reached within the 20-minute replay window. Original error: ${error.message}`));
    return;
  }

  // Increment attempts before scheduling reconnection
  state.reconnectAttempts += 1;

  // Ensure we resume from last tracked slot on next attempt
  const resumeSlot = state.confirmedSlot > 0 ? state.confirmedSlot : state.trackedSlot;
  if (resumeSlot > 0) {
    state.subscription.fromSlot = resumeSlot.toString();
  }

  setTimeout(() => {
    subscribeWithReplayTracking(
      state.config,
      state.subscription,
      state.onData,
      state.onError,
      state.reconnectAttempts
    ).catch(state.onError);
  }, FIXED_RECONNECT_INTERVAL_MS); // Use fixed 5-second interval
}
