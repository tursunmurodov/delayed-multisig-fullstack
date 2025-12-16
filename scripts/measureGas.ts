import pkg from "hardhat";
const { ethers } = pkg;
import * as fs from "fs";
import * as path from "path";

async function gasOf(tx: any) { const rc = await tx.wait(); return rc?.gasUsed?.toString() || "0"; }

async function main() {
  const [a, b, c] = await ethers.getSigners();
  const F = await ethers.getContractFactory("DelayedExecutionMultiSig");
  const D = await F.deploy([a.address,b.address,c.address], 2, 10, a.address);
  await D.waitForDeployment();

  const out = [["action","gas"]];

  const delay = 20;
  let tx = await D.connect(a).proposeTransaction(a.address, 0, "0x", delay);
  let rc = await tx.wait();
  const id = (rc!.logs.find((l:any)=>l.fragment?.name==="ProposalCreated") as any).args[0];
  out.push(["propose(tx)", rc.gasUsed.toString()]);

  tx = await D.connect(a).approve(id); out.push(["approve(A)", await gasOf(tx)]);
  tx = await D.connect(b).approve(id); out.push(["approve(B)", await gasOf(tx)]);
  tx = await D.connect(b).revoke(id); out.push(["revoke(B)", await gasOf(tx)]);
  tx = await D.connect(b).approve(id); out.push(["approve(B_again)", await gasOf(tx)]);

  const p = await D.getProposal(id);
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(p.eta)+1]);
  await ethers.provider.send("evm_mine", []);
  tx = await D.connect(c).execute(id); out.push(["execute", await gasOf(tx)]);

  const outPath = path.join("reports", "gas-report.csv");
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(outPath, out.map(r=>r.join(",")).join("\n"));
  console.log("Wrote", outPath);
}

main().catch(e=>{ console.error(e); process.exit(1); });
