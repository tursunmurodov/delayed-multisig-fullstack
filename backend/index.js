// ------------------------------------------------------------
// BACKEND — DelayedExecutionMultiSig (FULL WORKING VERSION)
// ------------------------------------------------------------
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ------------------------------------------------------------
// PATHS
// ------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load ABI
const abiPath = path.join(__dirname, "abi.json");
const abi = JSON.parse(fs.readFileSync(abiPath, "utf8"));

// Load ENV
dotenv.config({ path: path.join(__dirname, ".env") });

// ------------------------------------------------------------
// ENV VARIABLES
// ------------------------------------------------------------
const RPC_URL = process.env.RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!RPC_URL) throw new Error("❌ RPC_URL missing in .env");
if (!CONTRACT_ADDRESS) throw new Error("❌ CONTRACT_ADDRESS missing in .env");
if (!PRIVATE_KEY) throw new Error("❌ PRIVATE_KEY missing in .env");

// ------------------------------------------------------------
// BLOCKCHAIN SETUP
// ------------------------------------------------------------
console.log("🔗 Connecting to Sepolia RPC...");
const provider = new ethers.JsonRpcProvider(RPC_URL);

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
console.log("🔐 Backend signer:", wallet.address);

const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

// ------------------------------------------------------------
// EXPRESS APP
// ------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ------------------------------------------------------------
// IN-MEMORY PROPOSAL DB
// ------------------------------------------------------------
const cache = new Map();

function upsert(id, patch) {
  const prev = cache.get(id) || { id };
  const updated = { ...prev, ...patch };
  cache.set(id, updated);
  return updated;
}

// ------------------------------------------------------------
// CONTRACT EVENT LISTENERS
// ------------------------------------------------------------
console.log("👂 Listening to smart contract events...");

// Normal proposals
contract.on(
  "ProposalCreated",
  (id, proposer, to, value, eta) => {
    console.log("📘 EVENT — ProposalCreated:", id);

    upsert(id, {
      id,
      proposer,
      kind: "tx",
      govKind: null,
      to,
      value: value.toString(),
      eta: Number(eta),
      executed: false,
      cancelled: false,
    });
  }
);

// Governance proposals
contract.on(
  "GovernanceProposalCreated",
  (id, proposer, kind, eta) => {
    console.log("📗 EVENT — GovernanceProposalCreated:", id);

    upsert(id, {
      id,
      proposer,
      kind: "gov",
      govKind: Number(kind),
      to: null,
      value: "0",
      eta: Number(eta),
      executed: false,
      cancelled: false,
    });
  }
);

contract.on("ProposalApproved", (id, signer) => {
  console.log("🟩 EVENT — Approved:", id, "by", signer);
  upsert(id, { lastEvent: "approved" });
});

contract.on("ProposalRevoked", (id, signer) => {
  console.log("🟨 EVENT — Revoked:", id, "by", signer);
  upsert(id, { lastEvent: "revoked" });
});

contract.on("ProposalCancelled", (id, canceller) => {
  console.log("🟥 EVENT — Cancelled:", id, "by", canceller);
  upsert(id, { cancelled: true, lastEvent: "cancelled" });
});

contract.on("ProposalExecuted", (id, executor) => {
  console.log("🟦 EVENT — Executed:", id, "by", executor);
  upsert(id, { executed: true, lastEvent: "executed" });
});

// ------------------------------------------------------------
// ROUTES
// ------------------------------------------------------------

// HEALTH CHECK
app.get("/status", (req, res) => {
  res.json({ ok: true, message: "Backend is running." });
});

// CONTRACT INFO
app.get("/info", async (req, res) => {
  try {
    const threshold = await contract.threshold();
    const minDelay = await contract.minDelayGlobal();
    const owners = await contract.owners();
    const guardian = await contract.guardian();

    res.json({
      address: CONTRACT_ADDRESS,
      threshold: threshold.toString(),
      minDelay: minDelay.toString(),
      owners,
      guardian,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RETURN ALL PROPOSAL IDS
app.get("/proposal-ids", (req, res) => {
  res.json({ ids: Array.from(cache.keys()) });
});

// RETURN SINGLE PROPOSAL
app.get("/proposals/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const p = await contract.getProposal(id);
    const cached = cache.get(id);

    res.json({
      id,
      proposer: p.proposer,
      to: p.to,
      value: p.value.toString(),
      eta: Number(p.eta),
      approvals: Number(p.approvals),
      executed: p.executed,
      cancelled: p.cancelled,
      kind: cached?.kind || (p.kind === 0 ? "tx" : "gov"),
      govKind: cached?.govKind || null,
    });
  } catch (err) {
    res.status(404).json({ error: "Not found", detail: err.message });
  }
});

// ------------------------------------------------------------
// CREATE NEW NORMAL TRANSACTION PROPOSAL
// ------------------------------------------------------------
app.post("/propose", async (req, res) => {
  try {
    const { to, value } = req.body;

    if (!to || !value) {
      return res.status(400).json({ error: "Missing to or value" });
    }

    const delay = await contract.minDelayGlobal();

    console.log("🟦 Submitting normal proposal:", to, value.toString());

    const tx = await contract.proposeTransaction(
      to,
      BigInt(value),
      "0x",
      delay
    );

    const receipt = await tx.wait();

    return res.json({ ok: true, txHash: receipt.hash });
  } catch (err) {
    console.error("❌ /propose ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});
