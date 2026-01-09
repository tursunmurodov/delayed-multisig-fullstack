# Delayed Execution Multi-Signature Wallet Prototype (Full-Stack)

This repository contains a full-stack implementation of a **Delayed Execution Multi-Signature Wallet Prototype**, developed for a Bachelor Thesis project.

Author recommends to install the following before running prototype on your device:

- **Node.js** v18+
- **Git**
- **MetaMask** browser extension (for interacting with the frontend)

Optional (only for Sepolia testnet option):
- Alchemy/Infura RPC key
- Sepolia test ETH

---

### Clone the Repository

```bash
git clone https://github.com/yourusername/delayed-multisig-fullstack.git
cd delayed-multisig-fullstack
```

### Install Dependencies

Install root dependencies:

```bash
npm install
```

Install frontend and backend dependencies:

```bash
cd frontend
npm install
```

```bash
cd backend
npm install
```
---

## Environment Configuration (IMPORTANT PART)

The project requires environment variables in three locations. Create or edit (if needed) the following files:

### 1. Root `.env` (for Hardhat and contract deployment)

Create a `.env` file in the project root:

```bash
# Sepolia Testnet RPC URL
SEPOLIA_RPC_URL=https://rpc.sepolia.org

# Private key of the deployer account and this should start with 0x 
PRIVATE_KEY=0x_your_private_key_here

# Etherscan API Key (optional, for contract verification)
ETHERSCAN_API_KEY=your_etherscan_api_key_here
```
If you prefer local development with Hardhat node, you don't need these variables.

### 2. Backend `.env` (for the backend server)

Create `backend/.env`:

```bash
# RPC URL for connecting to blockchain
# For local: http://127.0.0.1:8545
# For Sepolia: https://rpc.sepolia.org 

RPC_URL=http://127.0.0.1:8545

# Contract address (set please after deployment)
CONTRACT_ADDRESS=0x_contract_address_here

# Private key of backend wallet which must be an owner of the contract
PRIVATE_KEY=0x_your_backend_wallet_private_key_here

# Server port (optional, defaults to 4000 but you can change it)
PORT=4000

# Frontend URL for email links
FRONTEND_URL=http://localhost:3000

# Email Configuration for notifications
# If not set, emails will be disabled so author recommends to set it!

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
MAIL_FROM=your-email@gmail.com

# Email Recipients
GUARDIAN_EMAIL=guardian@example.com
OWNER_EMAILS=owner1@example.com,owner2@example.com,owner3@example.com

# Risk Engine Settings (you are free to configure it)
RISK_TIMEZONE=UTC
RISK_WORKDAY_START=9
RISK_WORKDAY_END=17
```

### 3. Frontend `.env.local`

Create `frontend/.env.local`:

```bash
# Contract address set please after deployment

NEXT_PUBLIC_CONTRACT_ADDRESS=0x_contract_address_here

# Backend API URL usually http://localhost:4000 but if needed you can change it

NEXT_PUBLIC_BACKEND_URL=http://localhost:4000

# Infura API Key for better RPC reliability but it is optional
# If you do not have please get one at: https://infura.io/

NEXT_PUBLIC_INFURA_KEY=your_infura_project_id_here
```

---

## Compiling Contracts

Before deploying, compile the smart contracts:

```bash
npm run compile
```

---

## Running the Project

### Option 1: Local Development 

#### Start Hardhat Local Node

In one terminal window:

```bash
npm run node
```

This starts a local blockchain and keep this running ! 

#### Deploy Contracts Locally

In a new terminal window:

```bash
npm run deploy:local
```

**Important**: Copy the deployed contract address from the output. You'll need it for the `.env` files.

Example output:
```
✅ Contract deployed to: 0x5F...
```

Update your environment files:

- `backend/.env`: Set `CONTRACT_ADDRESS=0x5F...`
- 
- `frontend/.env.local`: Set `NEXT_PUBLIC_CONTRACT_ADDRESS=0x5F...`

Also update `backend/.env` with:

- `RPC_URL=http://127.0.0.1:8545`
- `PRIVATE_KEY` should be the first account from Hardhat node 

#### Start Backend Server

In a new terminal:

```bash
npm run backend
```

You should see:
```
🔗 Connecting to Sepolia RPC...
🔐 Backend signer: 0x...
👂 Listening to smart contract events...
🚀 Backend running at http://localhost:4000
```

#### Start Frontend

In another new terminal:

```bash
npm run dev
```

Or:

```bash
cd frontend
npm run dev
```

The frontend will be available at: **http://localhost:3000**



### Option 2: Run Both Servers Together

You can also run both backend and frontend together:

```bash
# Terminal 1: Backend
npm run backend

# Terminal 2: Frontend  
npm run dev
```

Or:

```bash
npm run dev:all
```

### Option 3: Deploy to Sepolia Testnet

For testing on a real testnet:

#### **Important**: Get Testnet ETH

Get Sepolia ETH from a faucet:

- https://sepoliafaucet.com/
- https://faucet.sepolia.dev/

#### Configure Environment

Ensure root `.env` has:

```bash
SEPOLIA_RPC_URL=https://rpc.sepolia.org
PRIVATE_KEY=0x_your_private_key_with_sepolia_eth
```

#### Deploy to Sepolia 

```bash
npm run deploy:sepolia
```

Copy the deployed address and update:

- `backend/.env`: `RPC_URL=https://rpc.sepolia.org` and `CONTRACT_ADDRESS=...`
- `frontend/.env.local`: `NEXT_PUBLIC_CONTRACT_ADDRESS=...`

#### Start Servers

```bash
npm run backend  # In one terminal
npm run dev      # In another terminal
```

---

## Running Tests

The project includes comprehensive smart contract tests and if you want to make sure that project and its all main functions are working well you can just run: 

### Run all Tests

```bash
npm test
```


## Key Scripts

### Root Package Scripts

- `npm run compile` - Compile smart contracts
- `npm test` - Run all tests
- `npm run node` - Start local Hardhat node
- `npm run deploy:local` - Deploy to local network
- `npm run deploy:sepolia` - Deploy to Sepolia testnet
- `npm run measure:gas` - Measure gas usage
- `npm run backend` - Start backend server
- `npm run dev` - Start frontend dev server
- `npm run dev:all` - Start both backend and frontend

### Frontend Scripts

- `cd frontend && npm run dev` - Development server
- `cd frontend && npm run build` - Production build
- `cd frontend && npm run start` - Production server
- `cd frontend && npm run lint` - Run linter

---

## Troubleshooting

### Port Already in Use

If you get "EADDRINUSE" errors:

```bash
# Kill process on port 4000 (backend)
lsof -ti:4000 | xargs kill -9

# Kill process on port 3000 (frontend)
lsof -ti:3000 | xargs kill -9

# Kill process on port 8545 (Hardhat node)
lsof -ti:8545 | xargs kill -9
```

### Contract Not Deployed

Make sure you:
1. Started Hardhat node (`npm run node`)
2. Deployed contracts (`npm run deploy:local`)
3. Updated `.env` files with the contract address

### Backend Can't Connect to Blockchain

Check:
1. Hardhat node is running (for local) or RPC_URL is correct (for Sepolia)
2. `CONTRACT_ADDRESS` in `backend/.env` matches deployed address
3. `PRIVATE_KEY` in `backend/.env` is valid and the account has ETH

### Frontend Can't Connect to Backend

Check:
1. Backend is running on port 4000
2. `NEXT_PUBLIC_BACKEND_URL` in `frontend/.env.local` is correct
3. CORS is enabled in backend (should be by default)

### Tests Failing

Make sure:
1. Hardhat is properly installed: `npm install`
2. All dependencies are installed
3. Run `npm run compile` before tests

### MetaMask Connection Issues

For local development:
1. Add Hardhat network to MetaMask:
   - Network Name: Hardhat Local
   - RPC URL: http://127.0.0.1:8545
   - Chain ID: 31337
   - Currency Symbol: ETH
2. Import one of Hardhat's test accounts (private keys are shown when you start `npm run node`)




