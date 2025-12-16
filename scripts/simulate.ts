import { ethers } from "hardhat";
import { DelayedExecutionMultiSig } from "../typechain/DelayedExecutionMultiSig";

function encAddOwner(addr: string) {
  return ethers.AbiCoder.defaultAbiCoder().encode(["bytes1", "address"], ["0x01", addr]);
}

async function main() {
  const [a, b, c, x] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("DelayedExecutionMultiSig");
  const owners = [a.address, b.address, c.address];
  const threshold = 2;
  const minDelay = 10;
  const guardian = a.address;

  const D = (await Factory.deploy(owners, threshold, minDelay, guardian)) as DelayedExecutionMultiSig;
  await D.waitForDeployment();
  const addr = await D.getAddress();
  console.log("\n✅ Contract deployed at:", addr);

  // ========== TRANSACTION PROPOSAL ==========
  const delay = 20;
  console.log("\n📝 Creating transaction proposal...");
  const tx = await D.connect(a).proposeTransaction(a.address, 0, "0x", delay);
  const rc = await tx.wait();
  const idTx = (rc!.logs.find((l: any) => l.fragment?.name === "ProposalCreated") as any).args[0];
  console.log("🆔 Tx Proposal ID:", idTx);

  await (await D.connect(a).approve(idTx)).wait();
  await (await D.connect(b).approve(idTx)).wait();
  console.log("✅ Approved by A and B");

  const p = await D.getProposal(idTx);
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(p.eta) + 1]);
  await ethers.provider.send("evm_mine", []);
  await (await D.connect(c).execute(idTx)).wait();
  console.log("🚀 Executed transaction proposal");

  // ========== GOVERNANCE PROPOSAL ==========
  console.log("\n📝 Creating governance proposal (add owner)...");
  const encoded = encAddOwner(x.address);
  const tx2 = await D.connect(a).proposeGovernance(encoded, 20);
  const rc2 = await tx2.wait();
  const idG = (rc2!.logs.find((l: any) => l.fragment?.name === "GovernanceProposalCreated") as any).args[0];
  console.log("🆔 Gov Proposal ID:", idG);

  await (await D.connect(a).approve(idG)).wait();
  await (await D.connect(b).approve(idG)).wait();
  console.log("✅ Approved by A and B");

  const p2 = await D.getProposal(idG);
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(p2.eta) + 1]);
  await ethers.provider.send("evm_mine", []);
  await (await D.connect(c).execute(idG)).wait();
  console.log("🚀 Executed governance addOwner proposal");

  const ownersFinal = await D.owners();
  console.log("\n👥 Final Owners:", ownersFinal);
  console.log("\n✅ Simulation complete — all proposals executed successfully.");
}

main().catch((e) => {
  console.error("❌ Error in simulation:", e);
  process.exit(1);
});
