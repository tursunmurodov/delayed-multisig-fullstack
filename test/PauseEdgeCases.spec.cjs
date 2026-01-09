const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Parse an event from a tx receipt (ethers v6). Returns decoded args or null.
 */
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
 * Safely get bytes32 id from event args (named or indexed).
 */
function eventId(args) {
  return args?.id ?? args?.[0];
}

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

/**
 * Create a simple tx proposal and return its id.
 */
async function createTxProposal(contract, proposer, to, value, delay) {
  const tx = await contract.connect(proposer).proposeTransaction(to, value, "0x", delay);
  const receipt = await tx.wait();

  const created = parseEvent(receipt, contract, "ProposalCreated");
  expect(created).to.not.equal(null);

  return eventId(created);
}

describe("DelayedExecutionMultiSig (Pause + Double-Action Edge Cases)", function () {
  it("A) Pause blocks approve", async function () {
    const { contract, owner1, owner2, guardian, outsider, minDelay } = await deployFixture();

    const id = await createTxProposal(contract, owner1, outsider.address, 0n, minDelay);

    await expect(contract.connect(guardian).pause()).to.emit(contract, "Paused");

    // approve should be blocked while paused
    await expect(contract.connect(owner2).approve(id)).to.be.reverted;
  });

  it("B) Pause blocks execute even after ETA", async function () {
    const { contract, owner1, owner2, guardian, outsider, minDelay } = await deployFixture();

    const id = await createTxProposal(contract, owner1, outsider.address, 0n, minDelay);

    await contract.connect(owner1).approve(id);
    await contract.connect(owner2).approve(id);

    // move to eta (execution would normally be allowed now)
    const p0 = await contract.getProposal(id);
    await time.increaseTo(Number(p0.eta) + 1);

    await expect(contract.connect(guardian).pause()).to.emit(contract, "Paused");

    // execute should be blocked while paused
    await expect(contract.connect(outsider).execute(id)).to.be.reverted;
  });

  it("C) Only guardian can pause/resume", async function () {
    const { contract, owner1, guardian } = await deployFixture();

    await expect(contract.connect(owner1).pause()).to.be.reverted;
    await expect(contract.connect(guardian).pause()).to.emit(contract, "Paused");

    await expect(contract.connect(owner1).resume()).to.be.reverted;
    await expect(contract.connect(guardian).resume()).to.emit(contract, "Resumed");
  });

  it("D) Approve twice reverts", async function () {
    const { contract, owner1, owner2, outsider, minDelay } = await deployFixture();

    const id = await createTxProposal(contract, owner1, outsider.address, 0n, minDelay);

    await expect(contract.connect(owner2).approve(id)).to.emit(contract, "ProposalApproved");

    // approving the same proposal twice must fail
    await expect(contract.connect(owner2).approve(id)).to.be.reverted;
  });

  it("E) Execute twice reverts", async function () {
    const { contract, owner1, owner2, outsider, minDelay } = await deployFixture();

    const id = await createTxProposal(contract, owner1, outsider.address, 0n, minDelay);

    await contract.connect(owner1).approve(id);
    await contract.connect(owner2).approve(id);

    const p0 = await contract.getProposal(id);
    await time.increaseTo(Number(p0.eta) + 1);

    // first execute ok
    await expect(contract.connect(outsider).execute(id)).to.emit(contract, "ProposalExecuted");

    // second execute must fail
    await expect(contract.connect(outsider).execute(id)).to.be.reverted;
  });

  it("Option B) Guardian can still cancel while paused", async function () {
    const { contract, owner1, owner2, guardian, outsider, minDelay } = await deployFixture();

    const id = await createTxProposal(contract, owner1, outsider.address, 0n, minDelay);

    await contract.connect(owner1).approve(id);
    await contract.connect(owner2).approve(id);

    await expect(contract.connect(guardian).pause()).to.emit(contract, "Paused");

    await expect(contract.connect(guardian).cancel(id, "cancel while paused"))
      .to.emit(contract, "ProposalCancelled");
  });
});
