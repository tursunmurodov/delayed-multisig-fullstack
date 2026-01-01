# Threat Model

## Assets
- **Funds held by contract**: ETH / ERP-20 tokens.
- **Governance Power**: Ability to change `owners`, `threshold`, `delay`, `guardian`.

## Actors
1. **Owners**: Trusted entities (High trust, but keys can be stolen).
2. **Guardian**: Emergency monitor (High trust, but reactive only).
3. **Attacker**: External actor or compromised internal key.

## Threats & Mitigations

### 1. Compromised Owner Key (k < threshold)
- **Threat**: Attacker proposes malicious tx.
- **Mitigation**: Attacker needs `k` signatures. 1 key is insufficient.
- **Response**: Other owners remove the compromised owner.

### 2. Compromised Quorum (k >= threshold)
- **Threat**: Attacker has enough keys to approve a tx immediately.
- **Mitigation**: **Time Delay**. The tx cannot be executed immediately.
- **Response**: The `Guardian` (cold key / separate entity) detects the alert and calls `cancel()` before `ETA`.

### 3. Compromised Guardian
- **Threat**: Guardian denies legitimate service (DOS) by cancelling all txs.
- **Mitigation**: Guardian cannot *create* or *execute* txs, only cancel. Funds are safe, just frozen.
- **Response**: Owners vote to replace the Guardian (subject to delay, so risky if owners also compromised, but usually safe).

### 4. Replay Attacks
- **Threat**: Re-submitting a signed valid tx payload.
- **Mitigation**: `txId` includes a `nonce` or uniqueness constraint. State `executed` prevents reuse.

## Residual Risks
- **Total Compromise**: If Owners (Quorum) AND Guardian are compromised simultaneously, funds are lost.
- **Smart Contract Bugs**: Standard risk for any solidity code.
