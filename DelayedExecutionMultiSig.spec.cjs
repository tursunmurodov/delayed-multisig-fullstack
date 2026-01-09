const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

function parseEvent(receipt, contract, eventName) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === eventName) return parsed.args;
    } catch (_) {}
  }
  return null;
}

/**
 * Extract bytes32 id from a parsed event args object safely.
 */
function eventId(args) {
  // ethers Result supports both named fields and numeric indexes
  return args?.id ?? args?.[0];
}

describe("DelayedExecutionMultiSig (Automated Security + Lifecycle)", function () {
  async function deployFixture() {
    const [owner1, owner2, owner3, guardian, outsider] = await ethers.getSigners();

    const owners = [owner1.address, owner2.address, owner3.address];
    const threshold = 2;
    const minDelay = 60;

    const Factory = await ethers.getContractFactory("DelayedExecutionMultiSig");
    const contract = await Factory.deploy(owners, threshold, minDelay, guardian.address);
    await contract.waitForDeployment();

    return { contract, owner1, owner2, owner3, guardian, outsider, threshold, minDelay };
  }

  it("deploys with expected initial config", async function () {
    const { contract, guardian, threshold, minDelay } = await deployFixture();

    expect(await contract.threshold()).to.equal(threshold);
    expect(await contract.minDelayGlobal()).to.equal(minDelay);
    expect(await contract.guardian()).to.equal(guardian.address);

    const owners = await contract.owners();
    expect(owners.length).to.equal(3);
  });

  it("only owners can proposeTransaction", async function () {
    const { contract, outsider, minDelay } = await deployFixture();
    await expect(
      contract.connect(outsider).proposeTransaction(outsider.address, 0n, "0x", minDelay)
    ).to.be.reverted;
  });

  it("proposal lifecycle: approve -> blocked before ETA -> executes after ETA", async function () {
    const { contract, owner1, owner2, outsider, minDelay } = await deployFixture();

    const contractAddr = await contract.getAddress();
    await owner1.sendTransaction({
      to: contractAddr,
      value: ethers.parseEther("1.0"),
    });

    const to = outsider.address;
    const value = ethers.parseEther("0.01");

    const tx = await contract.connect(owner1).proposeTransaction(to, value, "0x", minDelay);
    const receipt = await tx.wait();

    const created = parseEvent(receipt, contract, "ProposalCreated");
    expect(created).to.not.equal(null);

    const id = eventId(created);

    await expect(contract.connect(owner1).approve(id)).to.emit(contract, "ProposalApproved");
    await expect(contract.connect(owner2).approve(id)).to.emit(contract, "ProposalApproved");

    // Too early (ETA not reached)
    await expect(contract.connect(outsider).execute(id)).to.be.reverted;

    // Move time to ETA (or slightly after)
    const p0 = await contract.getProposal(id);
    await time.increaseTo(Number(p0.eta) + 1);

    await expect(contract.connect(outsider).execute(id)).to.emit(contract, "ProposalExecuted");

    const p1 = await contract.getProposal(id);
    expect(p1.executed).to.equal(true);
  });

  it("revoke reduces approvals", async function () {
    const { contract, owner1, owner2, outsider, minDelay } = await deployFixture();

    const tx = await contract
      .connect(owner1)
      .proposeTransaction(outsider.address, 0n, "0x", minDelay);
    const receipt = await tx.wait();

    const created = parseEvent(receipt, contract, "ProposalCreated");
    const id = eventId(created);

    await contract.connect(owner1).approve(id);
    await contract.connect(owner2).approve(id);

    let p = await contract.getProposal(id);
    expect(Number(p.approvals)).to.equal(2);

    await expect(contract.connect(owner2).revoke(id)).to.emit(contract, "ProposalRevoked");

    p = await contract.getProposal(id);
    expect(Number(p.approvals)).to.equal(1);
  });

  it("guardian cancellation blocks execution", async function () {
    const { contract, owner1, owner2, guardian, outsider, minDelay } = await deployFixture();

    const contractAddr = await contract.getAddress();
    await owner1.sendTransaction({ to: contractAddr, value: ethers.parseEther("0.1") });

    const tx = await contract
      .connect(owner1)
      .proposeTransaction(outsider.address, ethers.parseEther("0.01"), "0x", minDelay);
    const receipt = await tx.wait();

    const created = parseEvent(receipt, contract, "ProposalCreated");
    const id = eventId(created);

    await contract.connect(owner1).approve(id);
    await contract.connect(owner2).approve(id);

    await expect(contract.connect(guardian).cancel(id, "guardian cancellation")).to.emit(
      contract,
      "ProposalCancelled"
    );

    const p0 = await contract.getProposal(id);
    if (Number(p0.eta) > 0) {
      await time.increaseTo(Number(p0.eta) + 1);
    }

    await expect(contract.execute(id)).to.be.reverted;
  });

  it("expiry window enforced (cannot execute after eta + expiry)", async function () {
    const { contract, owner1, owner2, outsider, minDelay } = await deployFixture();

    // fund so execute failure doesn't come from balance
    const contractAddr = await contract.getAddress();
    await owner1.sendTransaction({ to: contractAddr, value: ethers.parseEther("0.1") });

    const tx = await contract
      .connect(owner1)
      .proposeTransaction(outsider.address, ethers.parseEther("0.01"), "0x", minDelay);
    const receipt = await tx.wait();

    const created = parseEvent(receipt, contract, "ProposalCreated");
    const id = eventId(created);

    await contract.connect(owner1).approve(id);
    await contract.connect(owner2).approve(id);

    const p = await contract.getProposal(id);
    const expiry = await contract.proposalExpiryDuration();

    await time.increaseTo(Number(p.eta) + Number(expiry) + 2);
    await expect(contract.execute(id)).to.be.reverted;
  });

  it("pause/resume blocks and restores state-changing actions", async function () {
    const { contract, owner1, guardian, outsider, minDelay } = await deployFixture();

    await expect(contract.connect(guardian).pause()).to.emit(contract, "Paused");

    await expect(
      contract.connect(owner1).proposeTransaction(outsider.address, 0n, "0x", minDelay)
    ).to.be.reverted;

    await expect(contract.connect(guardian).resume()).to.emit(contract, "Resumed");
  });

  it("governance proposal changes threshold (kind=0x03)", async function () {
    const { contract, owner1, owner2, minDelay } = await deployFixture();

    const newThreshold = 3n;

    // encoded = bytes1(kind) || abi.encode(arg)
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [newThreshold]);
    const encoded = ethers.concat(["0x03", payload]); // kind = 0x03 (changeThreshold)

    const tx = await contract.connect(owner1).proposeGovernance(encoded, minDelay);
    const receipt = await tx.wait();

    const created = parseEvent(receipt, contract, "GovernanceProposalCreated");
    expect(created).to.not.equal(null);

    const id = eventId(created);

    await contract.connect(owner1).approve(id);
    await contract.connect(owner2).approve(id);

    const p0 = await contract.getProposal(id);
    await time.increaseTo(Number(p0.eta) + 1);

    await expect(contract.execute(id)).to.emit(contract, "ProposalExecuted");
    expect(await contract.threshold()).to.equal(newThreshold);
  });
});
