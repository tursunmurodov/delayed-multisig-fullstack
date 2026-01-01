# System Architecture

## Component Diagram
\`\`\`mermaid
graph TD
    User[User / Owner] -->|Propose/Approve| FE[Frontend (Next.js)]
    Guardian -->|Cancel/Veto| FE
    FE -->|Read State| BE[Backend API]
    FE -->|Write Tx| SC[Smart Contract]
    
    SC -->|Emit Events| BE
    BE -->|Listen & Index| Indexer[Event Indexer]
    Indexer -->|Update| DB[(JSON / In-Memory State)]
    
    Guardian -->|Monitor| Alerts[Email Notifications]
    BE -->|Trigger| Alerts
\`\`\`

## 1. Smart Contract (`DelayedExecutionMultiSig.sol`)
- **Role**: Source of Truth.
- **State**:
  - `owners`: List of authorized signers.
  - `guardian`: Emergency role.
  - `txId`: Unique identifier for proposals.
  - `proposals`: Mapping of ID to struct (status, ETA, signatures).
- **Key Mechanics**:
  - **Proposal**: Any owner can propose.
  - **Approval**: Owners must approve. Reaching `k` signatures changes state to `Queued`.
  - **Delay**: Once `Queued`, `ETA = block.timestamp + delay`.
  - **Execution**: Can only occur execution `block.timestamp > ETA`.

## 2. Backend (Node.js)
- **Role**: Indexer & Notification System.
- **Components**:
  - **Event Listener**: Subscribes to `Proposed`, `Approved`, `Executed`, `Cancelled`.
  - **State Cache**: Maintains a fast-read state of active proposals (avoiding heavy chain queries).
  - **Notifier**: Sends Emails via SMTP when a high-risk action (Propsoal/Execution) occurs.

## 3. Frontend (Next.js)
- **Role**: Interface.
- **Features**:
  - Connect Wallet (Wagmi/Viem).
  - Dashboard: View active vs history proposals.
  - Action Center: Sign/Approve pending proposals.
