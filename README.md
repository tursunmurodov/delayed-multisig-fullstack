# DelayedExecutionMultiSig — Fullstack Demo

## Quickstart (Local)
1. `npm i`
2. `cp .env.example .env`
3. Start chain: `npm run node`
4. Deploy: `npm run deploy:local` → copy address
5. Edit `.env` → set `CONTRACT_ADDRESS=<address>`
6. Start backend+UI (serves / and APIs): `npm run backend`
7. New terminal: `npm run simulate:local` (creates proposals; refresh UI)
8. Tests: `npm test`
9. Gas report: `npm run measure:gas` → `reports/gas-report.csv`

## Governance encoding
- Add owner: bytes1 0x01 || abi.encode(address)
- Remove owner: 0x02 || abi.encode(address)
- Set threshold: 0x03 || abi.encode(uint256)
- Set minDelay: 0x04 || abi.encode(uint256)
- Set guardian: 0x05 || abi.encode(address)

## Behaviour
- Delay must be >= `minDelayGlobal`.
- `cancel()` allowed by owner or guardian only before ETA.
- `execute()` allowed by anyone after ETA if approvals >= threshold.
