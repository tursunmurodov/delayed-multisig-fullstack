// BACKEND — DelayedExecutionMultiSig
/**
 * @title Backend Service
 * @notice Handles off-chain indexing, risk scoring, and email notifications.
 * @dev
 * Modules:
 * 1. Event Listener: Syncs with Sepolia contract events.
 * 2. In-Memory Cache: Fast read-model for frontend.
 * 3. Risk Engine: Computes 'risk score' (0-100) based on heuristics.
 * 4. Notification Service: Sends SMTP emails to Owners/Guardian.
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";
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
// EMAIL CONFIG (guardian-only risk + owners normal)
// .env (recommended):
//   GUARDIAN_EMAIL=guardian@email
//   OWNER_EMAILS=o1@email,o2@email
// legacy fallback:
//   NOTIFY_EMAILS=...
// ------------------------------------------------------------
const GUARDIAN_EMAIL = (process.env.GUARDIAN_EMAIL || "").trim();
const OWNER_EMAILS = (process.env.OWNER_EMAILS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LEGACY_NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || "0");
const SMTP_SECURE = String(process.env.SMTP_SECURE || "true") === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "";

const EMAIL_ENABLED =
  Boolean(SMTP_HOST) &&
  Number.isFinite(SMTP_PORT) &&
  SMTP_PORT > 0 &&
  Boolean(SMTP_USER) &&
  Boolean(SMTP_PASS) &&
  Boolean(MAIL_FROM);

const transporter = EMAIL_ENABLED
  ? nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  })
  : null;

function normalizeRecipients() {
  // If you didn't set OWNER_EMAILS but you kept NOTIFY_EMAILS, treat NOTIFY_EMAILS as owners.
  const owners = OWNER_EMAILS.length ? OWNER_EMAILS : LEGACY_NOTIFY_EMAILS;
  const guardian = GUARDIAN_EMAIL || ""; // guardian must be explicit to receive risk
  return { owners, guardian };
}

async function sendEmailTo(toList, subject, text) {
  if (!EMAIL_ENABLED) {
    console.log("📭 Email disabled. Missing SMTP_*");
    return;
  }

  const to = Array.isArray(toList) ? toList.filter(Boolean).join(",") : String(toList || "");
  if (!to) return;

  try {
    await transporter.sendMail({ from: MAIL_FROM, to, subject, text });
    console.log("📧 Email sent:", subject, "->", to);
  } catch (err) {
    console.error("❌ Email send failed:", err?.message || err);
  }
}

// ------------------------------------------------------------
// NOTIFICATION STATE (avoid duplicate emails)
// Stored in backend/notifications.json
// ------------------------------------------------------------
const notificationsFile = path.join(__dirname, "notifications.json");

function loadNotifyState() {
  try {
    if (!fs.existsSync(notificationsFile)) return {};
    return JSON.parse(fs.readFileSync(notificationsFile, "utf8"));
  } catch {
    return {};
  }
}

function saveNotifyState(state) {
  try {
    fs.writeFileSync(notificationsFile, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("❌ Failed to save notifications.json:", e?.message || e);
  }
}

const notifyState = loadNotifyState();
// notifyState[id] = { createdSent, thresholdSent, etaWarnSent, etaWarnAt }

function getState(id) {
  if (!notifyState[id]) notifyState[id] = {};
  return notifyState[id];
}

function mark(id, patch) {
  const s = getState(id);
  Object.assign(s, patch);
  saveNotifyState(notifyState);
}

// Timers for ETA-10min
const etaTimers = new Map();
function clearEtaTimer(id) {
  const t = etaTimers.get(id);
  if (t) clearTimeout(t);
  etaTimers.delete(id);
}

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
// HELPERS
// ------------------------------------------------------------
function fmtTime(unix) {
  if (!unix || Number(unix) <= 0) return "N/A";
  return new Date(Number(unix) * 1000).toLocaleString();
}

function proposalLink(id) {
  if (!FRONTEND_URL) return "";
  return `${FRONTEND_URL}/?proposal=${id}`;
}

async function fetchOnchainProposal(id) {
  const p = await contract.getProposal(id);
  return {
    proposer: p.proposer,
    to: p.to,
    value: p.value.toString(),
    eta: Number(p.eta),
    approvals: Number(p.approvals),
    executed: p.executed,
    cancelled: p.cancelled,
    kind: Number(p.kind), // 0 tx, 1 gov
    data: (p.data || "0x").toString(),
  };
}

// ------------------------------------------------------------
// GUARDIAN AUTH (signature gate)
// Frontend will send:
//   x-guardian-ts: <unix seconds>
//   x-guardian-signature: <signature of message below>
// ------------------------------------------------------------
function buildGuardianMessage(ts) {
  return `Guardian access for risk data.\nContract: ${CONTRACT_ADDRESS}\nTimestamp: ${ts}`;
}

let guardianCache = { addr: null, fetchedAt: 0 };

async function getGuardianOnchain() {
  const now = Date.now();
  if (guardianCache.addr && now - guardianCache.fetchedAt < 30_000) return guardianCache.addr;
  const g = (await contract.guardian()).toLowerCase();
  guardianCache = { addr: g, fetchedAt: now };
  return g;
}

async function isGuardianRequest(req) {
  try {
    const signature = req.headers["x-guardian-signature"];
    const ts = req.headers["x-guardian-ts"];
    if (!signature || !ts) return false;

    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return false;

    // replay prevention: 5 min window
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - tsNum) > 300) return false;

    const msg = buildGuardianMessage(tsNum);
    const recovered = ethers.verifyMessage(msg, signature).toLowerCase();

    const guardianOnchain = await getGuardianOnchain();
    return recovered === guardianOnchain;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// RISK SCORING (persisted) - guardian only
// Stored in backend/risk-state.json
// Optional env:
//   RISK_TIMEZONE=Europe/Riga
//   RISK_BLACKLIST=0xabc...,0xdef...
// ------------------------------------------------------------
const riskFile = path.join(__dirname, "risk-state.json");

function loadRiskState() {
  try {
    if (!fs.existsSync(riskFile)) {
      return { seenRecipients: {}, proposerStats: {}, proposalMeta: {} };
    }
    return JSON.parse(fs.readFileSync(riskFile, "utf8"));
  } catch {
    return { seenRecipients: {}, proposerStats: {}, proposalMeta: {} };
  }
}

function saveRiskState(state) {
  try {
    fs.writeFileSync(riskFile, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("❌ Failed to save risk-state.json:", e?.message || e);
  }
}

const riskState = loadRiskState();
const riskCache = new Map(); // id -> risk object

const RISK_TIMEZONE = process.env.RISK_TIMEZONE || "Europe/Riga";

const BLACKLIST = (process.env.RISK_BLACKLIST || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Always-on blacklist
if (!BLACKLIST.includes("0x0000000000000000000000000000000000000000"))
  BLACKLIST.push("0x0000000000000000000000000000000000000000");
if (!BLACKLIST.includes("0x000000000000000000000000000000000000dead"))
  BLACKLIST.push("0x000000000000000000000000000000000000dead");

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function level(score) {
  if (score <= 29) return "LOW";
  if (score <= 69) return "MEDIUM";
  return "HIGH";
}
function add(reasons, text) {
  reasons.push(text);
}
function getHourInTZ(tsSec) {
  const d = new Date(tsSec * 1000);
  const hStr = d.toLocaleString("en-GB", {
    timeZone: RISK_TIMEZONE,
    hour: "2-digit",
    hour12: false,
  });
  return Number(hStr);
}

// v2 tuned selector weights (less explosive than old version)
const SELECTOR_POINTS = {
  "0x095ea7b3": { pts: 18, label: "ERC20 approve" },
  "0xa9059cbb": { pts: 6, label: "ERC20 transfer" },
  "0x23b872dd": { pts: 10, label: "ERC20 transferFrom" },
  "0x3659cfe6": { pts: 25, label: "upgradeTo (proxy upgrade)" },
  "0x4f1ef286": { pts: 25, label: "upgradeToAndCall (proxy upgrade)" },
};

// v2 governance mapping (base 60 + add)
const GOV_POINTS = {
  1: { add: 10, label: "addOwner" },
  2: { add: 15, label: "removeOwner" },
  3: { add: 20, label: "changeThreshold" },
  4: { add: 15, label: "changeMinDelay" },
  5: { add: 25, label: "changeGuardian" },
};

// ------------------------------------------------------------
// ✅ RISK SCORING v2
// @notice Heuristic-based scoring engine for proposals.
// @dev Inputs: Time of day, Value (ETH), Recipient (New/Blacklist), Method (Proxy/Upgrade).
// Output: Score 0-100 and mapped Level (LOW/MEDIUM/HIGH).
// ------------------------------------------------------------
async function computeRisk(id) {
  const p = await fetchOnchainProposal(id);

  const threshold = Number(await contract.threshold());
  const owners = (await contract.owners()).map((o) => o.toLowerCase());
  const guardian = (await getGuardianOnchain()).toLowerCase();

  const now = Math.floor(Date.now() / 1000);
  const reasons = [];
  const signals = {};

  let critical = false;
  const criticalFlags = [];

  const proposer = (p.proposer || "").toLowerCase();
  const kind = Number(p.kind); // 0 tx, 1 gov

  // ensure containers exist
  if (!riskState.seenRecipients) riskState.seenRecipients = {};
  if (!riskState.proposerStats) riskState.proposerStats = {};
  if (!riskState.proposalMeta) riskState.proposalMeta = {};

  if (!riskState.proposerStats[proposer]) {
    riskState.proposerStats[proposer] = { proposalTimes: [], approvalsByProposal: {} };
  }
  if (!riskState.proposalMeta[id]) {
    riskState.proposalMeta[id] = { createdAt: now, proposer };
  }

  const createdAt = Number(riskState.proposalMeta[id].createdAt || now);
  const stats = riskState.proposerStats[proposer];

  // avoid inflation on recompute
  if (!Array.isArray(stats.proposalTimes)) stats.proposalTimes = [];
  if (!stats.proposalTimes.includes(createdAt)) stats.proposalTimes.push(createdAt);
  stats.proposalTimes = stats.proposalTimes.slice(-50);

  // ---------------------------
  // TIME SUBSCORE (0..15)
  // ---------------------------
  let timePts = 0;

  const hour = getHourInTZ(createdAt);
  if (hour >= 0 && hour < 6) {
    timePts += 4;
    add(reasons, "Time risk: created during night/low-activity hours.");
  }

  let timeToEta = null;
  if (Number(p.eta) > 0) {
    timeToEta = Number(p.eta) - now;

    // modest urgency bumps
    if (timeToEta > 0 && timeToEta <= 600) {
      timePts += 8;
      add(reasons, "Time risk: ETA very close (≤ 10 minutes).");
    } else if (timeToEta > 0 && timeToEta <= 1800) {
      timePts += 4;
      add(reasons, "Time risk: ETA approaching (≤ 30 minutes).");
    } else if (timeToEta > 0 && timeToEta <= 7200) {
      timePts += 2;
    }
  }

  timePts = clamp(timePts, 0, 15);
  signals.time = { hour, tz: RISK_TIMEZONE, timeToEta };

  // ---------------------------
  // BEHAVIOR SUBSCORE (0..15)
  // ---------------------------
  let behaviorPts = 0;
  const start = now - 600; // last 10 minutes
  const proposalsLast10m = stats.proposalTimes.filter((t) => t >= start).length;

  if (proposalsLast10m >= 6) {
    behaviorPts += 15;
    add(reasons, "Behavior risk: many proposals created in last 10 minutes (very unusual).");
  } else if (proposalsLast10m >= 4) {
    behaviorPts += 12;
    add(reasons, "Behavior risk: multiple proposals created in last 10 minutes.");
  }

  const appr = (stats.approvalsByProposal && stats.approvalsByProposal[id]) || [];
  if (Array.isArray(appr) && appr.length >= 2) {
    const span = appr[appr.length - 1] - appr[0];
    if (span <= 60) {
      behaviorPts += 8;
      add(reasons, "Behavior risk: approvals accumulated very fast (≤ 60s).");
    }
    signals.behavior = { proposalsLast10m, approvalsFastSpanSec: span };
  } else {
    signals.behavior = { proposalsLast10m, approvalsFastSpanSec: null };
  }

  behaviorPts = clamp(behaviorPts, 0, 15);

  // Threshold reached is informative but should not spike score alone
  if (Number(p.approvals) >= threshold) {
    behaviorPts = clamp(behaviorPts + 4, 0, 15);
    add(reasons, "Behavior signal: threshold reached (actionable after delay).");
  }

  // ---------------------------
  // GOVERNANCE BRANCH (usually HIGH by nature)
  // ---------------------------
  if (kind === 1) {
    let score = 60;
    add(reasons, "Function risk: governance proposal (high impact by design).");

    const dataHex = (p.data || "0x").toString();
    let govKind = null;
    if (dataHex.length >= 4) govKind = parseInt(dataHex.slice(2, 4), 16);

    const g = GOV_POINTS[govKind];
    if (g) {
      score += g.add;
      add(reasons, `Governance risk: action = ${g.label}.`);
      critical = true;
      criticalFlags.push(`gov:${g.label}`);
    } else {
      score += 20;
      add(reasons, "Governance risk: unknown action.");
      critical = true;
      criticalFlags.push("gov:unknown");
    }

    // add modest behavior/time influence
    score += Math.round((timePts / 15) * 10);
    score += Math.round((behaviorPts / 15) * 10);

    score = clamp(score, 0, 100);

    const out = {
      id,
      score,
      level: level(score),
      reasons,
      signals: { ...signals, govKind, criticalFlags },
      computedAt: now,
    };

    saveRiskState(riskState);
    riskCache.set(id, out);
    return out;
  }

  // ---------------------------
  // TX SUBSCORES (transaction)
  // ---------------------------

  // AMOUNT SUBSCORE (0..35)
  let amountPts = 0;
  const ETH = 1_000_000_000_000_000_000n;
  const valueWei = BigInt(p.value || "0");

  // absolute tiers (more gentle than before)
  if (valueWei >= 5n * ETH) {
    amountPts = 35;
    add(reasons, "Amount risk: very high value (≥ 5 ETH).");
    critical = true;
    criticalFlags.push("amount:>=5eth");
  } else if (valueWei >= 1n * ETH) {
    amountPts = 25;
    add(reasons, "Amount risk: high value (≥ 1 ETH).");
  } else if (valueWei >= 200_000_000_000_000_000n) {
    amountPts = 14;
    add(reasons, "Amount risk: moderate value (≥ 0.2 ETH).");
  } else if (valueWei >= 50_000_000_000_000_000n) {
    amountPts = 6;
    add(reasons, "Amount risk: small but notable (≥ 0.05 ETH).");
  }

  // relative to wallet balance tiers (use MAX, not add)
  let pct = null;
  try {
    const bal = await provider.getBalance(CONTRACT_ADDRESS);
    if (bal > 0n) {
      pct = Number((valueWei * 10000n) / bal) / 100;
      let relPts = 0;

      if (pct >= 60) {
        relPts = 30;
        add(reasons, `Amount risk: transfer is ${pct}% of wallet balance (very high).`);
        critical = true;
        criticalFlags.push("amount:>=60%balance");
      } else if (pct >= 30) {
        relPts = 20;
        add(reasons, `Amount risk: transfer is ${pct}% of wallet balance (high).`);
      } else if (pct >= 15) {
        relPts = 12;
      } else if (pct >= 5) {
        relPts = 6;
      }

      amountPts = Math.max(amountPts, relPts);
      signals.amount = { valueWei: valueWei.toString(), balanceWei: bal.toString(), pct };
    } else {
      signals.amount = { valueWei: valueWei.toString(), balanceWei: "0", pct: null };
    }
  } catch {
    signals.amount = { valueWei: valueWei.toString(), balanceWei: null, pct: null };
  }

  amountPts = clamp(amountPts, 0, 35);

  // RECIPIENT SUBSCORE (0..25)
  let recipientPts = 0;
  const to = (p.to || "").toLowerCase();
  const isOwner = owners.includes(to);
  const isGuardian = to === guardian;

  if (BLACKLIST.includes(to)) {
    recipientPts = 25;
    add(reasons, "Recipient risk: address is blacklisted/dangerous.");
    critical = true;
    criticalFlags.push("recipient:blacklist");
  } else {
    if (!isOwner && !isGuardian) {
      recipientPts += 10;
      add(reasons, "Recipient risk: destination is not an owner/guardian (unknown).");
    }

    if (to && !riskState.seenRecipients[to]) {
      recipientPts += 6;
      add(reasons, "Recipient risk: destination has never been used in this system.");
    }

    try {
      const txCount = await provider.getTransactionCount(to);
      if (txCount === 0) {
        recipientPts += 8;
        add(reasons, "Recipient risk: destination appears brand new (txCount=0).");
      }
      signals.recipient = { to, isOwner, isGuardian, txCount };
    } catch {
      signals.recipient = { to, isOwner, isGuardian, txCount: null };
    }
  }

  recipientPts = clamp(recipientPts, 0, 25);

  // FUNCTION SUBSCORE (0..25)
  let functionPts = 0;
  const dataHex = (p.data || "0x").toString();

  if (dataHex && dataHex !== "0x" && dataHex.length >= 10) {
    const sel = dataHex.slice(0, 10).toLowerCase();
    const info = SELECTOR_POINTS[sel];

    if (info) {
      functionPts += info.pts;
      add(reasons, `Function risk: call matches ${info.label} (${sel}).`);

      if (sel === "0x3659cfe6" || sel === "0x4f1ef286") {
        critical = true;
        criticalFlags.push("function:proxy-upgrade");
      }
    } else {
      functionPts += 10;
      add(reasons, `Function risk: non-empty calldata with unknown selector (${sel}).`);
    }

    signals.function = { selector: sel, dataLen: dataHex.length };
  } else {
    signals.function = { selector: null, dataLen: dataHex?.length || 0 };
  }

  functionPts = clamp(functionPts, 0, 25);

  // Mark recipient as seen AFTER scoring
  if (to) riskState.seenRecipients[to] = true;

  // ---------------------------
  // FINAL COMBINE (scaled, not raw sum)
  // ---------------------------
  // Caps already applied:
  // amount <= 35, recipient <= 25, function <= 25, behavior <= 15, time <= 15  -> max 115
  const raw = amountPts + recipientPts + functionPts + behaviorPts + timePts;
  const RAW_MAX = 115;
  let score = Math.round((raw / RAW_MAX) * 100);

  // If critical flag exists, prevent “critical but low”
  if (critical && score < 70) score = 70;

  score = clamp(score, 0, 100);

  signals.points = { amountPts, recipientPts, functionPts, behaviorPts, timePts, raw, RAW_MAX };
  signals.criticalFlags = criticalFlags;

  const out = {
    id,
    score,
    level: level(score),
    reasons,
    signals,
    computedAt: now,
  };

  saveRiskState(riskState);
  riskCache.set(id, out);
  return out;
}

function riskTextBlock(risk) {
  if (!risk) return "\nRISK: unavailable\n";
  return `\nRISK: ${risk.level} (${risk.score}/100)\nReasons:\n- ${risk.reasons.join("\n- ")}\n`;
}

// ------------------------------------------------------------
// NOTIFY HELPERS (owners vs guardian)
// ------------------------------------------------------------
async function emailOwners(subject, body) {
  const { owners } = normalizeRecipients();
  await sendEmailTo(owners, subject, body);
}

async function emailGuardian(subject, body, risk) {
  const { guardian } = normalizeRecipients();
  if (!guardian) return; // guardian email must be set explicitly
  await sendEmailTo(guardian, `${subject} (Guardian view)`, body + riskTextBlock(risk));
}

// ------------------------------------------------------------
// schedule “executable soon” email at ETA - 10 min
// ------------------------------------------------------------
async function scheduleEtaWarning(id, eta) {
  const warnAt = Number(eta) - 600;
  if (!warnAt || warnAt <= 0) return;

  const s = getState(id);
  if (s.etaWarnSent) return;

  if (s.etaWarnAt === warnAt && etaTimers.has(id)) return;

  clearEtaTimer(id);
  mark(id, { etaWarnAt: warnAt });

  const now = Math.floor(Date.now() / 1000);
  const delayMs = (warnAt - now) * 1000;

  const run = async () => {
    const st = getState(id);
    if (st.etaWarnSent) return;

    try {
      const p = await fetchOnchainProposal(id);
      if (p.executed || p.cancelled) return;

      const subject = "⏳ Proposal becomes executable in ~10 minutes";
      const body =
        `A proposal is approaching execution time.\n\n` +
        `Proposal ID: ${id}\n` +
        `Proposer: ${p.proposer}\n` +
        `To: ${p.to}\n` +
        `Value (wei): ${p.value}\n` +
        `Approvals: ${p.approvals}\n` +
        `Executable at (ETA): ${fmtTime(p.eta)}\n` +
        (FRONTEND_URL ? `\nOpen UI: ${proposalLink(id)}\n` : "");

      await emailOwners(subject, body);

      const risk = riskCache.get(id) || (await computeRisk(id));
      await emailGuardian(subject, body, risk);

      mark(id, { etaWarnSent: true });
    } catch (err) {
      console.error("❌ ETA warning failed:", err?.message || err);
    }
  };

  if (delayMs <= 0) setTimeout(run, 1000);
  else {
    const timer = setTimeout(run, delayMs);
    etaTimers.set(id, timer);
  }

  console.log(`⏳ ETA warning scheduled for ${id} at ${fmtTime(warnAt)}`);
}

async function sendCreatedEmail(id, kindLabel, govKind = null) {
  const s = getState(id);
  if (s.createdSent) return;

  const p = await fetchOnchainProposal(id);

  const subject = "🆕 New proposal created";
  const body =
    `A new proposal has been created in the DelayedExecutionMultiSig wallet.\n\n` +
    `Proposal ID: ${id}\n` +
    `Type: ${kindLabel}${govKind !== null ? ` (govKind=${govKind})` : ""}\n` +
    `Proposer: ${p.proposer}\n` +
    (kindLabel === "tx" ? `To: ${p.to}\nValue (wei): ${p.value}\n` : "") +
    `ETA (execution after delay): ${fmtTime(p.eta)}\n` +
    (FRONTEND_URL ? `\nOpen UI: ${proposalLink(id)}\n` : "");

  await emailOwners(subject, body);

  const risk = riskCache.get(id) || (await computeRisk(id));
  await emailGuardian(subject, body, risk);

  mark(id, { createdSent: true });
  await scheduleEtaWarning(id, p.eta);
}

async function maybeSendThresholdEmail(id) {
  const s = getState(id);
  if (s.thresholdSent) return;

  const p = await fetchOnchainProposal(id);
  const threshold = Number(await contract.threshold());

  if (p.approvals >= threshold) {
    const subject = "✅ Proposal reached required approvals (threshold)";
    const body =
      `A proposal has reached the approval threshold.\n\n` +
      `Proposal ID: ${id}\n` +
      `Approvals: ${p.approvals} / ${threshold}\n` +
      `ETA: ${fmtTime(p.eta)}\n` +
      `Status: ${p.executed ? "EXECUTED" : p.cancelled ? "CANCELLED" : "PENDING"}\n` +
      (FRONTEND_URL ? `\nOpen UI: ${proposalLink(id)}\n` : "");

    await emailOwners(subject, body);

    const risk = riskCache.get(id) || (await computeRisk(id));
    await emailGuardian(subject, body, risk);

    mark(id, { thresholdSent: true });
    await scheduleEtaWarning(id, p.eta);
  }
}

// ------------------------------------------------------------
// CONTRACT EVENT LISTENERS
// ------------------------------------------------------------
console.log("👂 Listening to smart contract events...");

function ensureProposerStats(proposer) {
  const p = proposer.toLowerCase();
  if (!riskState.proposerStats[p]) {
    riskState.proposerStats[p] = { proposalTimes: [], approvalsByProposal: {} };
  }
  if (!Array.isArray(riskState.proposerStats[p].proposalTimes)) {
    riskState.proposerStats[p].proposalTimes = [];
  }
  if (!riskState.proposerStats[p].approvalsByProposal) {
    riskState.proposerStats[p].approvalsByProposal = {};
  }
  return riskState.proposerStats[p];
}

// Normal proposals
contract.on("ProposalCreated", async (id, proposer, to, value, eta) => {
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
    lastEvent: "created",
  });

  // Risk meta + behavior seed (append once here)
  const createdAt = Math.floor(Date.now() / 1000);
  riskState.proposalMeta[id] = { createdAt, proposer: proposer.toLowerCase() };

  const stats = ensureProposerStats(proposer);
  stats.proposalTimes.push(createdAt);
  stats.proposalTimes = stats.proposalTimes.slice(-50);

  saveRiskState(riskState);

  await computeRisk(id);
  await sendCreatedEmail(id, "tx");
});

// Governance proposals
contract.on("GovernanceProposalCreated", async (id, proposer, kind, eta) => {
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
    lastEvent: "created",
  });

  const createdAt = Math.floor(Date.now() / 1000);
  riskState.proposalMeta[id] = { createdAt, proposer: proposer.toLowerCase() };

  const stats = ensureProposerStats(proposer);
  stats.proposalTimes.push(createdAt);
  stats.proposalTimes = stats.proposalTimes.slice(-50);

  saveRiskState(riskState);

  await computeRisk(id);
  await sendCreatedEmail(id, "gov", Number(kind));
});

// approvals -> threshold reached check
contract.on("ProposalApproved", async (id, signer) => {
  console.log("🟩 EVENT — Approved:", id, "by", signer);
  upsert(id, { lastEvent: "approved" });

  try {
    const p = await fetchOnchainProposal(id);
    const proposer = p.proposer.toLowerCase();
    const stats = ensureProposerStats(proposer);

    if (!stats.approvalsByProposal[id]) stats.approvalsByProposal[id] = [];
    stats.approvalsByProposal[id].push(Math.floor(Date.now() / 1000));
    stats.approvalsByProposal[id] = stats.approvalsByProposal[id].slice(-20);

    saveRiskState(riskState);
  } catch { }

  await computeRisk(id);
  await maybeSendThresholdEmail(id);
});

contract.on("ProposalRevoked", async (id, signer) => {
  console.log("🟨 EVENT — Revoked:", id, "by", signer);
  upsert(id, { lastEvent: "revoked" });
  await computeRisk(id);
});

contract.on("ProposalCancelled", async (id, canceller) => {
  console.log("🟥 EVENT — Cancelled:", id, "by", canceller);
  upsert(id, { cancelled: true, lastEvent: "cancelled" });
  clearEtaTimer(id);
  await computeRisk(id);
});

contract.on("ProposalExecuted", async (id, executor) => {
  console.log("🟦 EVENT — Executed:", id, "by", executor);
  upsert(id, { executed: true, lastEvent: "executed" });
  clearEtaTimer(id);
  await computeRisk(id);
});

// ------------------------------------------------------------
// ROUTES
// ------------------------------------------------------------

// HEALTH CHECK
app.get("/status", (req, res) => {
  res.json({ ok: true, message: "Backend is running." });
});

// (resume / unpause) - must be called by guardian signer in backend wallet
app.post("/resume", async (req, res) => {
  try {
    const tx = await contract.resume();
    const receipt = await tx.wait();
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// ✅ FIXED CONTRACT INFO (NO NOTIFY_EMAILS BUG ANYMORE)
app.get("/info", async (req, res) => {
  try {
    const threshold = await contract.threshold();
    const minDelay = await contract.minDelayGlobal();
    const owners = await contract.owners();
    const guardian = await contract.guardian();
    const paused = await contract.paused();

    const { owners: ownerRecipients, guardian: guardianRecipient } = normalizeRecipients();

    res.json({
      address: CONTRACT_ADDRESS,
      threshold: threshold.toString(),
      minDelay: minDelay.toString(),
      owners,
      guardian,
      paused: Boolean(paused),
      emailNotifications: {
        enabled: EMAIL_ENABLED,
        ownerRecipients,
        guardianRecipient: guardianRecipient || null,
        usingLegacyNotifyEmails: !OWNER_EMAILS.length && LEGACY_NOTIFY_EMAILS.length > 0,
      },
      risk: {
        timezone: RISK_TIMEZONE,
        blacklistCount: BLACKLIST.length,
        guardianSignatureRequired: true,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// RETURN ALL PROPOSAL IDS
app.get("/proposal-ids", (req, res) => {
  res.json({ ids: Array.from(cache.keys()) });
});

// GUARDIAN-ONLY RISK ENDPOINT
app.get("/risk/:id", async (req, res) => {
  try {
    const ok = await isGuardianRequest(req);
    if (!ok) return res.status(403).json({ error: "guardian only" });

    const id = req.params.id;
    const risk = riskCache.get(id) || (await computeRisk(id));
    if (!risk) return res.status(404).json({ error: "risk not found" });

    res.json(risk);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// RETURN SINGLE PROPOSAL
// - Everyone gets proposal details
// - Guardian (with signature headers) also gets "risk"
app.get("/proposals/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const p = await contract.getProposal(id);
    const cached = cache.get(id);

    const showRisk = await isGuardianRequest(req);
    const risk = showRisk ? (riskCache.get(id) || (await computeRisk(id))) : null;

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
      risk, // null unless guardian-authenticated
    });
  } catch (err) {
    res.status(404).json({ error: "Not found", detail: err?.message || String(err) });
  }
});

// CREATE NEW NORMAL TRANSACTION PROPOSAL
app.post("/propose", async (req, res) => {
  try {
    const { to, value } = req.body;

    if (!to || !value) {
      return res.status(400).json({ error: "Missing to or value" });
    }

    const delay = await contract.minDelayGlobal();
    console.log("🟦 Submitting normal proposal:", to, value.toString());

    const tx = await contract.proposeTransaction(to, BigInt(value), "0x", delay);
    const receipt = await tx.wait();

    return res.json({ ok: true, txHash: receipt.hash });
  } catch (err) {
    console.error("❌ /propose ERROR:", err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});
