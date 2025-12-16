import { expect } from "chai";
import { ethers } from "hardhat";

describe("DelayedExecutionMultiSig", function () {
  it("M-of-N + delay enforced", async () => {
    const [a,b,c] = await ethers.getSigners();
    const F = await ethers.getContractFactory("DelayedExecutionMultiSig");
    const D = await F.deploy([a.address,b.address,c.address], 2, 10, a.address);
    await D.waitForDeployment();

    const tx = await D.connect(a).proposeTransaction(a.address, 0, "0x", 20);
    const rc = await tx.wait();
    const id = (rc!.logs.find((l:any)=>l.fragment?.name==="ProposalCreated") as any).args[0];

    await (await D.connect(a).approve(id)).wait();
    const p = await D.getProposal(id);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(p.eta)+1]);
    await ethers.provider.send("evm_mine", []);
    await expect(D.connect(c).execute(id)).to.be.reverted; // need quorum

    await (await D.connect(b).approve(id)).wait();
    await expect(D.connect(c).execute(id)).to.not.be.reverted;
  });

  it("revoke before ETA only; cancel by owner or guardian before ETA", async () => {
    const [a,b,c,g] = await ethers.getSigners();
    const F = await ethers.getContractFactory("DelayedExecutionMultiSig");
    const D = await F.deploy([a.address,b.address,c.address], 2, 10, g.address);
    await D.waitForDeployment();

    const tx = await D.connect(a).proposeTransaction(a.address, 0, "0x", 20);
    const rc = await tx.wait();
    const id = (rc!.logs.find((l:any)=>l.fragment?.name==="ProposalCreated") as any).args[0];

    await (await D.connect(a).approve(id)).wait();
    await expect(D.connect(a).revoke(id)).to.not.be.reverted; // before ETA ok

    await (await D.connect(a).approve(id)).wait();
    const p = await D.getProposal(id);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(p.eta)+1]);
    await ethers.provider.send("evm_mine", []);
    await expect(D.connect(a).revoke(id)).to.be.reverted; // after ETA

    const tx2 = await D.connect(a).proposeTransaction(a.address, 0, "0x", 20);
    const rc2 = await tx2.wait();
    const id2 = (rc2!.logs.find((l:any)=>l.fragment?.name==="ProposalCreated") as any).args[0];
    await (await D.connect(a).approve(id2)).wait();
    await expect(D.connect(g).cancel(id2, "risk")).to.not.be.reverted;
  });

  it("governance: add owner", async () => {
    const [a,b,c,x] = await ethers.getSigners();
    const F = await ethers.getContractFactory("DelayedExecutionMultiSig");
    const D = await F.deploy([a.address,b.address,c.address], 2, 10, a.address);
    await D.waitForDeployment();

    const encoded = ethers.solidityPacked(["bytes1","address"], ["0x01", x.address]);
    const tx = await D.connect(a).proposeGovernance(encoded, 20);
    const rc = await tx.wait();
    const id = (rc!.logs.find((l:any)=>l.fragment?.name==="GovernanceProposalCreated") as any).args[0];

    await (await D.connect(a).approve(id)).wait();
    await (await D.connect(b).approve(id)).wait();
    const p = await D.getProposal(id);
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(p.eta)+1]);
    await ethers.provider.send("evm_mine", []);
    await expect(D.connect(c).execute(id)).to.not.be.reverted;

    const owners = await D.owners();
    expect(owners).to.include(x.address);
  });
});
