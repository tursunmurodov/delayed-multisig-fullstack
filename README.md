# Delayed Execution MultiSig Wallet

**Bachelor Thesis Project: Verified Smart Contract Systems**
*A secure, time-delayed multisignature wallet with role-based governance and emergency safeguards.*

---

## 📖 Abstract

This repository contains the full-stack implementation of a **Delayed Execution Multisignature Wallet**. The system is designed to govern high-value assets with an added layer of security: time delays. By enforced mandatory waiting periods for transaction execution, the system mitigates the risk of key compromise and insider threats, allowing legitimate owners to cancel malicious proposals before they are finalized.

## 🏛 Architecture

The system consists of three main layers:
1. **Smart Contracts (Solidity)**: The core logic for proposal lifecycle, consensus (k-of-n), and time-locks.
2. **Backend (Node.js/Express)**: An indexer and notification service that listens to on-chain events and audits system state.
3. **Frontend (Next.js)**: A user-friendly dApp interface for Proposing, Approving, and Executing transactions.

### Key Security Features
- **Mandatory Time Delay**: All governance actions (except emergency cancellations) must mature for `minDelay` seconds.
- **Guardian Role**: A specific `guardian` address capable of pausing the contract or vetoing malicious transactions during the delay period.
- **Role-Based Access**: Strict separation between `owners` (proposers/approvers) and `guardian`.
- **Replay Protection**: Unique `txId` generation based on nonce and payload.

## 🛠 Tech Stack

- **Blockchain**: Solidity 0.8.x, Hardhat, Ethers.js
- **Backend**: Node.js, Express, Nodemailer (for alerts)
- **Frontend**: Next.js (App Router), Wagmi, TailwindCSS/Shadcn
- **Testing**: Hardhat Waffle (Chai)

## 🚀 Setup & Installation

### Prerequisites
- Node.js v16+
- Git

### 1. Clone & Install
\`\`\`bash
git clone https://github.com/tursunmurodov/delayed-multisig-fullstack.git
cd delayed-multisig-fullstack
npm install
\`\`\`

### 2. Configure Environment
Set up the environment variables for each component.
\`\`\`bash
# Root (Contracts)
cp .env.example .env

# Backend
cp backend/.env.example backend/.env

# Frontend
cp frontend/.env.local.example frontend/.env.local
\`\`\`

### 3. Run Locally (Full System)
The project includes scripts to run everything in parallel for demonstration.

\`\`\`bash
# Terminal 1: Start Hardhat Node
npm run node

# Terminal 2: Deploy Contracts (Local)
npm run deploy:local
# -> COPY the deployed address to your root .env and backend/.env

# Terminal 3: Start Backend & Frontend
npm run dev:all
\`\`\`

## 🧪 Testing

Run the comprehensive suite of smart contract tests:
\`\`\`bash
npm test
\`\`\`

For gas usage reports:
\`\`\`bash
npm run measure:gas
\`\`\`

## ⚖️ License
MIT
