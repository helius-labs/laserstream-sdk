# Mint filter verification — September 6, 2026

Mint matching passed the completed functional checks across JavaScript, Go,
Rust, live subscriptions, subscription replacement, forced reconnects, and
recent historical replay. Release preparation found JavaScript declaration and
package issues; the accompanying changes fix those issues and add regression
checks. No mint-filter runtime change was required by these results.

## Versions and scope

- SDK baseline: `e9e6ce21ae0d7c58d79f1db247178dcba24249fd`.
- Published JavaScript SDK/native package: `helius-laserstream` 0.8.5.
- Published Rust SDK: `helius-laserstream` 0.6.4; core proto 11.3.0. Built with
  default features disabled and with the default cuckoo feature enabled.
- Go: SDK source at the baseline above; Go 1.25.1.
- Live endpoint: `laserstream-mainnet-tyo.helius-rpc.com`; bounded read-only
  subscriptions. macOS ARM64, Node 23.7.0, Rust 1.97.1.
- Server unit tests: existing monorepo checkout at
  `fbc89bd6ab` (Rust 1.91.0); no server code was changed.

## Results

| Check | Result |
| --- | --- |
| Local SDK transport matrix | 80 steps passed across eight SDK/alias/replay combinations; 24 forced reconnects |
| Confirmed live checks, all three SDKs | Zero false positives or false negatives across more than 45,000 transaction records |
| Processed live check, JavaScript + USDC | 13,712 transaction records; 466,191 filter comparisons; zero mismatches |
| Finalized live check, Go + wrapped SOL | 5,166 transaction records; 175,644 comparisons; zero mismatches |
| Token-2022 compatibility sample, Rust | 2,427 transaction records; 82,501 comparisons; zero mismatches |
| Recent replay, all three SDKs | Each returned all 3,113 reference transactions and 3,113 statuses; identical filter results; no missing or extra transaction signatures |
| Live on/off toggle, mint replacement, forced reconnect | Passed for JavaScript, Go, and Rust; zero filter mismatches |
| Server filter unit suite | 154 passed, 2 existing production-data tests ignored; includes all 10 mint-specific tests |
| Archive mint-filter unit tests | 3 passed: include, exclude, and required |
| Go tests under race detector | SDK package and proto package passed |
| Independent oracle fixtures | 17 passed |
| JavaScript existing vectors | 11 cuckoo checks and V1 config vectors passed |
| Corrected declarations and all TypeScript examples | Strict declaration fixture and `build:ts` passed |
| Corrected npm package | Clean install, isolated tarball install, strict consumer compilation, and native module loading passed |

The live/replay runs that met their coverage thresholds checked more than
76,000 delivered transaction records and 2.58 million filter comparisons,
before counting the live transition tests. Replayed records are included in
these totals; they are not counts of unique on-chain transactions. Those runs
included 365 records where the target mint appeared in token balances but not
in account keys.

Every live stream included an unrestricted reference filter and checked the
other named filters against a separate set-based calculation over static and
loaded account keys plus pre/post token balances. Checks covered disabled and
omitted flags, negative controls, multiple mints, include/exclude/required
combinations, vote/failed predicates, and ATA flag coexistence. The same
expected filter decisions were compared with transaction-status notifications.

For replay, a separate grpc-js client captured complete confirmed slots
`444626476` through `444626485`. All three SDKs independently requested that
window using `fromSlot`, and their signature sets matched the capture exactly.

The local server checked both transaction filter maps, true/false/omitted/null
values, both JavaScript naming conventions, 1,000 addresses without truncation,
and preservation through three reconnects in each replay mode. Invalid
JavaScript strings, numbers, arrays, and objects were rejected.

## Release fixes

1. **Broken public TypeScript exports.** Version 0.8.5 re-exports message names
   that do not exist at the top level of `laserstream-core-proto-js/generated`.
   Strict library checking fails; `skipLibCheck` hides the errors and allows an
   invalid string `matchMints`. The fix exports the actual `geyser` interfaces,
   resolves local request/callback type references, and corrects the related
   cuckoo import. Example-required Solana types and native compression options
   are also typed correctly.
2. **Undeclared public typing dependency.** `ChannelOptions` refers to
   `@grpc/grpc-js`, which was absent from the package dependencies. Add it so an
   isolated consumer does not depend on accidental dependency hoisting. The
   JavaScript runtime continues to use the native client.
3. **Stale npm lockfile.** Package metadata says 0.8.5 while the lockfile still
   describes 0.8.4 and lacks the matching optional native packages. Refresh it;
   `npm ci --ignore-scripts` now succeeds.
4. **GNU CI package mirror failures.** Both GNU build jobs failed before
   compilation because `deb.debian.org/debian-security` returned 404 for
   required Bullseye packages. Use Debian's security mirror, which serves the
   same package URLs, while retaining the glibc 2.31 build environment.

The TypeScript regression test runs in the existing SDK CI workflow. The
transport/live harness is available alongside this report for the next release
candidate; see [README.md](README.md).

## Limits and non-passing attempts

- An initial processed-USDT sample had no mismatches but no balance-only mint
  matches, so it failed the coverage threshold. The processed-USDC run above
  supplied that coverage. Token-2022 was explicitly a compatibility sample:
  its target was present in account keys, so it did not independently prove
  the additional balance-only matching path.
- One initial Rust live-transition attempt timed out waiting for phase-two
  coverage. Three subsequent diagnostic runs passed without an SDK runtime change. Treat
  this as a bounded functional result, not an endurance or latency guarantee.
- The reference capture was reduced to ten non-vote slots after unrestricted
  captures could not complete the larger window within the time budget. The
  completed replay comparison uses all transactions in that recorded window.
- Live traffic was tested against one region. This does not certify every
  deployment, sustained throughput, or a long-running soak. Archive unit tests
  cover filter semantics; recent-slot replay does not prove cold archive I/O.
- Mint membership tests used explicit account lists. The existing cuckoo
  vectors passed, but mint membership inside cuckoo sets was not exercised.
- No package was published and no production configuration was changed.

Raw JSON summaries and the reference capture remain in the ignored `results/`
directory. Credentials are excluded from those artifacts.
