# Proposal Lifecycle

The lifecycle of a generic transaction in the Delay MultiSig:

## State Machine

\`\`\`mermaid
stateDiagram-v2
    [*] --> Proposed: Owner creates Proposal
    Proposed --> Pending: Signatures < Threshold
    Pending --> Queued: Signatures >= Threshold
    Queued --> Executable: Time > ETA
    Executable --> Executed: execute() called
    
    Proposed --> Cancelled: Cancelled by Owner/Guardian
    Pending --> Cancelled: Cancelled by Owner/Guardian
    Queued --> Cancelled: Cancelled by Owner/Guardian
    Executable --> Cancelled: Cancelled by Owner/Guardian
    
    Executed --> [*]
    Cancelled --> [*]
\`\`\`

## detailed Phases

### 1. Proposal
- **Action**: `propose(target, value, data)`
- **Condition**: Caller must be `owner`.
- **Result**: `TxId` generated. Signed by proposer automatically.

### 2. Approval (Voting)
- **Action**: `approve(txId)`
- **Condition**: Caller must be `owner`.
- **Logic**: Increments `approvalCount`. 
- **Transition**: If `approvalCount >= threshold`, the proposal **automatically** enters `Queued` state (or effectively becomes queue-able, depending on implementation: usually one step or explicit queue). *Note: in this implementation, queuing is automatic or explicit check? (Verify in code if precise).*  
  - *Assumption*: "Queued" implies the timer has started.

### 3. Time-Lock (Delay)
- **Duration**: `ETA = block.timestamp + delay`.
- **Constraints**:
  - Cannot execute before ETA.
  - **Guardian Veto**: Guardian can call `cancel(txId)` during this phase to stop a malicious attack.

### 4. Execution
- **Action**: `execute(txId)`
- **Conditions**: 
  - `block.timestamp >= ETA`
  - `approvals >= threshold`
  - Not cancelled.
  - Not executed.
- **Result**: Low-level call to `target` with `value` and `data`.
