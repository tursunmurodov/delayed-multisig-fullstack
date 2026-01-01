"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Providers } from "./providers";
import { wagmiConfig } from "../wagmi";
import {
  writeContract,
  waitForTransactionReceipt,
  readContract,
  signMessage,
} from "@wagmi/core";
import { isAddressEqual, encodeAbiParameters } from "viem";
import abi from "../../abi/abi.json";

const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

/* ------------------------------------------------------------------
   RETRY HELPER
------------------------------------------------------------------*/
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  baseDelay = 2000
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const err = error as { message?: string };
      const msg = (err?.message || "").toLowerCase();
      const isRateLimit =
        msg.includes("429") ||
        msg.includes("rate limit") ||
        msg.includes("too many requests");

      if (!isRateLimit || attempt === maxRetries - 1) throw error;

      const delay = baseDelay * Math.pow(2, attempt);
      console.warn(`Rate limited. Retrying in ${delay}ms…`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Max retries exceeded");
}

/* ------------------------------------------------------------------
   TYPES
------------------------------------------------------------------*/
type Risk = {
  id: string;
  score: number;
  level: "LOW" | "MEDIUM" | "HIGH";
  reasons: string[];
  signals?: any;
  computedAt: number;
};

interface Proposal {
  id: string;
  kind: "tx" | "gov";
  govKind?: number;
  to: string | null;
  value: string;
  eta: number;
  approvals?: number;
  cancelled: boolean;
  executed: boolean;
  risk?: Risk | null;
}

function PageContent() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [search, setSearch] = useState("");

  const [loading, setLoading] = useState(false);
  const [to, setTo] = useState("");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // pause + guardian
  const [paused, setPaused] = useState(false);
  const [guardian, setGuardian] = useState<`0x${string}` | null>(null);

  // optional debug
  const [readErr, setReadErr] = useState<string>("");

  // governance form
  const [govAction, setGovAction] = useState("");
  const [govArg, setGovArg] = useState("");
  const [govDelay, setGovDelay] = useState("");

  // guardian-only risk auth (signature + timestamp)
  const [riskAuth, setRiskAuth] = useState<{ ts: number; sig: `0x${string}` } | null>(null);

  const { address: userAddress } = useAccount();

  const isGuardian = useMemo(() => {
    return userAddress && guardian ? isAddressEqual(userAddress, guardian) : false;
  }, [userAddress, guardian]);

  /* ------------------------------------------------------------------
     EXACT MESSAGE MUST MATCH BACKEND buildGuardianMessage(ts)
  ------------------------------------------------------------------*/
  const buildGuardianMessage = (ts: number) =>
    `Guardian access for risk data.\nContract: ${CONTRACT_ADDRESS}\nTimestamp: ${ts}`;

  // ✅ FIX: Always return Record<string,string> (no undefined values, no union)
  function guardianHeadersOrEmpty(): Record<string, string> {
    if (!riskAuth) return {};

    // backend allows ±300s; we auto-lock earlier to avoid random failures
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - riskAuth.ts) > 240) {
      setRiskAuth(null);
      return {};
    }

    return {
      "x-guardian-ts": String(riskAuth.ts),
      "x-guardian-signature": riskAuth.sig,
    };
  }

  /* ------------------------------------------------------------------
     BACKEND INFO FALLBACK (fixes "buttons missing")
  ------------------------------------------------------------------*/
  const fetchBackendInfo = async () => {
    try {
      const r = await fetch(`${BACKEND_URL}/info`);
      const j = await r.json();
      if (j?.guardian) setGuardian(j.guardian as `0x${string}`);
      if (typeof j?.paused === "boolean") setPaused(Boolean(j.paused));
    } catch {
      // ignore if backend is down
    }
  };

  /* ------------------------------------------------------------------
     FETCH PAUSED (on-chain, with fallback)
  ------------------------------------------------------------------*/
  const fetchPaused = async () => {
    try {
      setReadErr("");
      const pausedStatus = await retryWithBackoff(() =>
        readContract(wagmiConfig, {
          address: CONTRACT_ADDRESS,
          abi,
          functionName: "paused",
        })
      );
      setPaused(pausedStatus as boolean);
    } catch (e: any) {
      setReadErr(`paused() read failed: ${e?.message || "unknown"}`);
      await fetchBackendInfo();
    }
  };

  /* ------------------------------------------------------------------
     FETCH GUARDIAN (on-chain, with fallback)
  ------------------------------------------------------------------*/
  const fetchGuardian = async () => {
    try {
      setReadErr("");
      const g = await retryWithBackoff(() =>
        readContract(wagmiConfig, {
          address: CONTRACT_ADDRESS,
          abi,
          functionName: "guardian",
        })
      );
      setGuardian(g as `0x${string}`);
    } catch (e: any) {
      setReadErr(`guardian() read failed: ${e?.message || "unknown"}`);
      await fetchBackendInfo();
    }
  };

  /* ------------------------------------------------------------------
     UNLOCK / LOCK RISK VIEW (guardian-only)
  ------------------------------------------------------------------*/
  const toggleRiskView = async () => {
    if (!isGuardian) {
      alert("❌ Only guardian can unlock risk view");
      return;
    }

    // lock
    if (riskAuth) {
      setRiskAuth(null);
      await fetchProposals();
      return;
    }

    // unlock
    try {
      const ts = Math.floor(Date.now() / 1000);
      const message = buildGuardianMessage(ts);

      const sig = await signMessage(wagmiConfig, { message });
      setRiskAuth({ ts, sig: sig as `0x${string}` });

      await fetchProposals({ forceRisk: true, ts, sig: sig as `0x${string}` });
    } catch (e) {
      console.error(e);
      alert("❌ Unlock failed (signature rejected or wallet issue)");
    }
  };

  /* ------------------------------------------------------------------
     PAUSE / RESUME
  ------------------------------------------------------------------*/
  const handlePauseResume = async (fn: "pause" | "resume") => {
    try {
      const tx = await writeContract(wagmiConfig, {
        address: CONTRACT_ADDRESS,
        abi,
        functionName: fn,
        args: [],
        gas: 200000n,
      });

      await waitForTransactionReceipt(wagmiConfig, { hash: tx });
      await fetchPaused();
      alert(`✅ ${fn} OK`);
    } catch (e: any) {
      alert(`❌ Failed to ${fn}: ${e?.message || ""}`);
    }
  };

  /* ------------------------------------------------------------------
     FETCH PROPOSALS
     @notice Fetches proposal IDs and details from Backend.
     @dev If Guardian is active/unlocked, injects signature headers for risk data.
  ------------------------------------------------------------------*/
  const fetchProposals = async (opts?: { forceRisk?: boolean; ts?: number; sig?: `0x${string}` }) => {
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/proposal-ids`);
      const { ids } = await res.json();

      let headers: Record<string, string> = {};

      if (opts?.forceRisk && opts.ts && opts.sig) {
        headers = {
          "x-guardian-ts": String(opts.ts),
          "x-guardian-signature": opts.sig,
        };
      } else if (riskAuth && isGuardian) {
        headers = guardianHeadersOrEmpty(); // ✅ now always Record<string,string>
      }

      const data = await Promise.all(
        (ids as string[]).map(async (id: string) => {
          const r = await fetch(`${BACKEND_URL}/proposals/${id}`, { headers });
          return await r.json();
        })
      );

      setProposals(data);
    } finally {
      setLoading(false);
    }
  };

  /* ------------------------------------------------------------------
     NORMAL ACTIONS
  ------------------------------------------------------------------*/
  const handleAction = async (
    action: "approve" | "execute" | "cancel" | "revoke",
    id: string
  ) => {
    try {
      const args =
        action === "cancel"
          ? [id, prompt("Enter reason") || "No reason"]
          : [id];

      const tx = await writeContract(wagmiConfig, {
        address: CONTRACT_ADDRESS,
        abi,
        functionName: action,
        args,
        gas: 400000n,
      });

      await waitForTransactionReceipt(wagmiConfig, { hash: tx });
      await fetchProposals();
    } catch {
      alert(`❌ Failed to ${action}`);
    }
  };

  /* ------------------------------------------------------------------
     SUBMIT TX PROPOSAL
  ------------------------------------------------------------------*/
  const submitProposal = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`${BACKEND_URL}/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, value }),
      });

      await res.json();
      setTo("");
      setValue("");
      await fetchProposals();
    } finally {
      setSubmitting(false);
    }
  };

  /* ------------------------------------------------------------------
     SUBMIT GOVERNANCE PROPOSAL
     @notice Encodes governance actions (byte prefix + ABI encoded args).
     @dev 0x01=AddOwner, 0x02=RemoveOwner, 0x03=SetThreshold, etc.
  ------------------------------------------------------------------*/
  async function submitGovernanceProposal() {
    try {
      let prefix = "";
      let encodedArg: `0x${string}`;

      switch (govAction) {
        case "addOwner":
          prefix = "0x01";
          encodedArg = encodeAbiParameters([{ type: "address" }], [govArg as `0x${string}`]);
          break;

        case "removeOwner":
          prefix = "0x02";
          encodedArg = encodeAbiParameters([{ type: "address" }], [govArg as `0x${string}`]);
          break;

        case "setThreshold":
          prefix = "0x03";
          encodedArg = encodeAbiParameters([{ type: "uint256" }], [BigInt(govArg)]);
          break;

        case "setMinDelayGlobal":
          prefix = "0x04";
          encodedArg = encodeAbiParameters([{ type: "uint256" }], [BigInt(govArg)]);
          break;

        case "setGuardian":
          prefix = "0x05";
          encodedArg = encodeAbiParameters([{ type: "address" }], [govArg as `0x${string}`]);
          break;

        default:
          alert("Invalid action");
          return;
      }

      const finalData = (prefix + encodedArg.slice(2)) as `0x${string}`;

      const tx = await writeContract(wagmiConfig, {
        address: CONTRACT_ADDRESS,
        abi,
        functionName: "proposeGovernance",
        args: [finalData, BigInt(govDelay)],
        gas: 500000n,
      });

      await waitForTransactionReceipt(wagmiConfig, { hash: tx });

      alert("✅ Governance Proposal Submitted");
      setGovAction("");
      setGovArg("");
      setGovDelay("");

      await fetchProposals();
    } catch {
      alert("❌ Governance proposal failed");
    }
  }

  /* ------------------------------------------------------------------
     INITIAL LOAD
  ------------------------------------------------------------------*/
  useEffect(() => {
    const load = async () => {
      setRiskAuth(null);
      await fetchBackendInfo();
      await fetchPaused();
      await new Promise((r) => setTimeout(r, 300));
      await fetchGuardian();
      await new Promise((r) => setTimeout(r, 300));
      await fetchProposals();
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userAddress]);

  /* ------------------------------------------------------------------
     FILTER
  ------------------------------------------------------------------*/
  const searchLower = search.toLowerCase();
  const filteredProposals = proposals.filter(
    (p) =>
      p.id.toLowerCase().includes(searchLower) ||
      (p.to && p.to.toLowerCase().includes(searchLower))
  );

  const showRiskColumn = isGuardian;
  const riskUnlocked = Boolean(riskAuth);

  /* ------------------------------------------------------------------
     UI
  ------------------------------------------------------------------*/
  return (
    <main className="p-4 max-w-5xl mx-auto">
      {/* HEADER */}
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Delayed MultiSig Wallet</h1>
        <ConnectButton />
      </div>

      {/* SEARCH */}
      <div className="flex gap-2 mb-6">
        <input
          type="text"
          placeholder="Search by ID or address"
          className="border px-2 py-1 w-full"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* STATUS + GUARDIAN CONTROLS */}
      <div className="mb-4">
        <p className="text-sm">
          Status:{" "}
          {paused ? (
            <span className="text-red-600 font-semibold">Paused</span>
          ) : (
            <span className="text-green-600 font-semibold">Active</span>
          )}
        </p>

        {/* debug */}
        <p className="text-xs text-gray-500 mt-1">
          connected: {userAddress || "—"} | guardian: {guardian || "—"} | isGuardian:{" "}
          {isGuardian ? "true" : "false"}
          {readErr ? ` | ⚠ ${readErr}` : ""}
        </p>

        {guardian && isGuardian && (
          <div className="mt-2 flex gap-2">
            <button
              className="bg-red-600 text-white px-4 py-1 rounded"
              disabled={paused}
              onClick={() => handlePauseResume("pause")}
            >
              Pause
            </button>

            <button
              className="bg-green-600 text-white px-4 py-1 rounded"
              disabled={!paused}
              onClick={() => handlePauseResume("resume")}
            >
              Resume
            </button>

            <button
              className="bg-black text-white px-4 py-1 rounded"
              onClick={toggleRiskView}
              title="Guardian-only. Requires message signature."
            >
              {riskUnlocked ? "Lock Risk View" : "Unlock Risk View"}
            </button>
          </div>
        )}
      </div>

      {/* TX FORM */}
      <div className="bg-gray-100 p-4 rounded mb-6">
        <h2 className="text-lg font-semibold mb-2">New Transaction Proposal</h2>
        <div className="flex flex-col gap-2">
          <input
            type="text"
            className="border p-2"
            placeholder="To (0x...)"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <input
            type="number"
            className="border p-2"
            placeholder="ETH Value (wei)"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
            onClick={submitProposal}
            disabled={!to || !value || submitting}
          >
            {submitting ? "Submitting..." : "Submit"}
          </button>
        </div>
      </div>

      {/* GOVERNANCE FORM */}
      <div className="bg-gray-100 p-4 rounded mb-6">
        <h2 className="text-lg font-semibold mb-2">Governance Proposal</h2>

        <div className="flex flex-col gap-3">
          <select
            className="border p-2"
            value={govAction}
            onChange={(e) => setGovAction(e.target.value)}
          >
            <option value="">Select Action</option>
            <option value="addOwner">Add Owner</option>
            <option value="removeOwner">Remove Owner</option>
            <option value="setThreshold">Change Threshold</option>
            <option value="setMinDelayGlobal">Change Min Delay</option>
          </select>

          {govAction && (
            <input
              className="border p-2"
              placeholder={
                govAction === "setThreshold" || govAction === "setMinDelayGlobal"
                  ? "Number"
                  : "Address (0x...)"
              }
              value={govArg}
              onChange={(e) => setGovArg(e.target.value)}
            />
          )}

          <input
            type="number"
            className="border p-2"
            placeholder="Delay (seconds)"
            value={govDelay}
            onChange={(e) => setGovDelay(e.target.value)}
          />

          <button
            className="bg-purple-600 text-white px-4 py-2 rounded disabled:opacity-50"
            disabled={!govAction || !govArg || !govDelay}
            onClick={submitGovernanceProposal}
          >
            Submit Governance Proposal
          </button>
        </div>
      </div>

      {/* PROPOSALS TABLE */}
      {loading ? (
        <p>Loading proposals...</p>
      ) : (
        <table className="w-full text-sm text-left border border-gray-700">
          <thead>
            <tr className="bg-gray-800 text-white">
              <th className="p-2">ID</th>
              <th className="p-2">Type</th>
              <th className="p-2">To</th>
              <th className="p-2">Value</th>
              <th className="p-2">ETA</th>
              {showRiskColumn && <th className="p-2">Risk</th>}
              <th className="p-2">Status</th>
              <th className="p-2">Actions</th>
            </tr>
          </thead>

          <tbody>
            {filteredProposals.map((p, i) => (
              <tr key={i} className="border-t border-gray-600">
                <td className="p-2 font-mono text-xs">{p.id.slice(0, 12)}…</td>

                <td className="p-2">
                  {p.kind === "gov" ? (
                    <span className="text-purple-600 font-semibold">Gov ({p.govKind})</span>
                  ) : (
                    <span className="text-blue-600 font-semibold">Tx</span>
                  )}
                </td>

                <td className="p-2">{p.kind === "tx" ? p.to : "—"}</td>
                <td className="p-2">{p.kind === "tx" ? p.value : "—"}</td>
                <td className="p-2">{new Date(p.eta * 1000).toLocaleString()}</td>

                {showRiskColumn && (
                  <td className="p-2">
                    {!riskUnlocked ? (
                      <span className="text-gray-500">🔒</span>
                    ) : p.risk ? (
                      <span
                        className={
                          p.risk.level === "HIGH"
                            ? "text-red-600 font-semibold"
                            : p.risk.level === "MEDIUM"
                              ? "text-yellow-700 font-semibold"
                              : "text-green-700 font-semibold"
                        }
                        title={p.risk.reasons?.join("\n")}
                      >
                        {p.risk.level} ({p.risk.score}/100)
                      </span>
                    ) : (
                      <span className="text-gray-500">—</span>
                    )}
                  </td>
                )}

                <td className="p-2">
                  {p.cancelled ? "❌ Cancelled" : p.executed ? "✅ Executed" : "⏳ Pending"}
                </td>

                <td className="p-2 flex gap-2 flex-wrap">
                  {!p.executed && !p.cancelled && (
                    <>
                      <button
                        className="bg-yellow-500 text-white px-2 py-1 text-xs rounded"
                        onClick={() => handleAction("approve", p.id)}
                      >
                        Approve
                      </button>

                      <button
                        className="bg-green-600 text-white px-2 py-1 text-xs rounded"
                        onClick={() => handleAction("execute", p.id)}
                      >
                        Execute
                      </button>

                      <button
                        className="bg-red-600 text-white px-2 py-1 text-xs rounded"
                        onClick={() => handleAction("cancel", p.id)}
                      >
                        Cancel
                      </button>

                      <button
                        className="bg-gray-600 text-white px-2 py-1 text-xs rounded"
                        onClick={() => handleAction("revoke", p.id)}
                      >
                        Revoke
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

export default function Page() {
  return (
    <Providers config={wagmiConfig}>
      <PageContent />
    </Providers>
  );
}
