# Mint filter release verification

These checks exercise the actual SDK transports. A local gRPC server captures
requests emitted by the published JavaScript native binary, the published Rust
crate, and the Go SDK in this checkout. No live endpoint is needed for the local
suite. It covers both transaction subscription maps, true/false/omitted/null,
camelCase and snake_case JavaScript inputs, include/exclude/required lists, ATA
flags, invalid JavaScript values, 1,000 mint addresses, subscription replacement,
and forced reconnects with replay enabled and disabled.

Requirements: Node.js 18+, Go 1.25.1+, Rust with Cargo, and a C++ toolchain for
the proto crate's bundled protoc build. Run from this directory:

```sh
npm ci --ignore-scripts
cd clients/go
go build -o client .
cd ../rust
cargo build --locked
cd ../..
node --test oracle.test.js
npm test
```

JavaScript is pinned to 0.8.5 and Rust to 0.6.4. To also exercise the Rust SDK's
default cuckoo feature, build with `cargo build --locked --features
helius-laserstream/cuckoo` in `clients/rust`. `MINT_SDKS=javascript,go,rust` selects
clients; the default also tests JavaScript's snake_case aliases.

To test checkout JavaScript code after installing/building it, set `MINT_JS_SDK`
to the absolute path of the checkout's `javascript/client.js`. Rust checkout
code can be selected with Cargo's `patch.crates-io.helius-laserstream.path`
configuration. Keep the published-package checks when testing a release.

## Live differential checks

Set `MINT_ENDPOINT` and `MINT_API_KEY` in the environment, or set `MINT_ENV_FILE`
to an environment file containing `LASERSTREAM_PRODUCTION_ENDPOINT` and
`LASERSTREAM_PRODUCTION_API_KEY`. Credentials are passed to clients through the
environment, never command-line arguments or reports.

```sh
MINT_SDKS=javascript,go,rust MINT_SECONDS=30 node verify.js live
```

One subscription includes an unrestricted reference filter and 16 additional
filters, duplicated in `transactionsStatus`. Every delivered transaction is
independently evaluated from static/loaded account keys and pre/post token
balances. The suite checks filter labels, status parity, disabled behavior,
negative controls, failed transactions, AND/OR combinations, and ATA flags.
It fails on mismatches, errors, or insufficient positive coverage. The reference
includes votes; this transfers substantial data. Use a suitable test endpoint.

The default is confirmed commitment and USDC. `MINT_COMMITMENT=0` selects
processed; `MINT_COMMITMENT=2` selects finalized. `MINT_TARGET` changes the mint.

## Historical replay completeness

The capture uses a separate grpc-js client, bypassing all three SDKs, to record
10 complete confirmed slots of non-vote transactions. Replay then checks exact
signature-set equality with that capture, in addition to filter correctness.
Run replay promptly, while the capture remains in the server's replay window.

```sh
node verify.js capture
MINT_SDKS=javascript,go,rust MINT_REFERENCE_FILE=results/reference.json \
  MINT_SECONDS=30 node verify.js replay
```

JSON summaries and the reference capture are written under ignored `results/`.
These are bounded functional checks, not a throughput benchmark or a fleet-wide
deployment check. Recent-slot replay does not by itself prove cold archive I/O.

To exercise server-side subscription replacement and a real reconnect, use:

```sh
MINT_SDKS=javascript,go,rust node verify.js transitions
```

This routes one SDK at a time through a local proxy that forwards raw protobuf
bytes. It toggles mint matching on/off, switches USDC to USDT, then injects one
stream failure and checks delivery after reconnect. Distinct reference labels
identify the request that produced each transaction, avoiding timing assumptions
about updates already in flight.

Live checks normally require at least one balance-only mint match. For token
programs that always include the mint in account keys, an explicit
`MINT_MIN_BALANCE_ONLY=0` allows a compatibility sample; the report still exposes
the zero count so it is not mistaken for coverage of the new matching behavior.

## TypeScript release checks

The fixture `types.ts` compiles against the installed release package. It
reproduces the 0.8.5 typing regression: the expected rejection of a string
`matchMints` value is missing. For the fixed checkout, run:

```sh
cd ../../javascript
npm ci --ignore-scripts
npm run test:types
npm run build:ts
```

The checkout regression test checks both annotated filters and inline
`subscribe`/`write` arguments with strict library checking enabled.
