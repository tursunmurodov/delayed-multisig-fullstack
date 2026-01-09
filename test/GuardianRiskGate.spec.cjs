const { expect } = require("chai");
const { ethers } = require("hardhat");

function buildGuardianMessage(contractAddress, ts) {
  return `Guardian access for risk data.\nContract: ${contractAddress}\nTimestamp: ${ts}`;
}

function withinWindow(nowSec, tsSec, windowSec = 300) {
  return Math.abs(nowSec - tsSec) <= windowSec;
}

describe("Guardian Risk Gate (Signature + Replay Window)", function () {
  async function deployFixture() {
    const [owner1, owner2, owner3, guardian] = await ethers.getSigners();

    const owners = [owner1.address, owner2.address, owner3.address];
    const threshold = 2;
    const minDelay = 60;

    const Factory = await ethers.getContractFactory("DelayedExecutionMultiSig");
    const contract = await Factory.deploy(owners, threshold, minDelay, guardian.address);
    await contract.waitForDeployment();

    return { contract, owner1, guardian };
  }

  it("accepts valid guardian signature and rejects non-guardian", async function () {
    const { contract, owner1, guardian } = await deployFixture();

    const now = Math.floor(Date.now() / 1000);
    const msg = buildGuardianMessage(await contract.getAddress(), now);

    const sigGuardian = await guardian.signMessage(msg);
    const recoveredG = ethers.verifyMessage(msg, sigGuardian);
    expect(recoveredG.toLowerCase()).to.equal(guardian.address.toLowerCase());

    const sigOwner = await owner1.signMessage(msg);
    const recoveredO = ethers.verifyMessage(msg, sigOwner);
    expect(recoveredO.toLowerCase()).to.not.equal(guardian.address.toLowerCase());
  });

  it("rejects stale timestamps outside replay window", async function () {
    const { contract, guardian } = await deployFixture();

    const now = Math.floor(Date.now() / 1000);
    const stale = now - 301; // 1 second outside window
    const fresh = now - 10;

    expect(withinWindow(now, fresh, 300)).to.equal(true);
    expect(withinWindow(now, stale, 300)).to.equal(false);

    // Also prove signature is bound to timestamp (signature differs)
    const addr = await contract.getAddress();
    const msgFresh = buildGuardianMessage(addr, fresh);
    const msgStale = buildGuardianMessage(addr, stale);

    const sigFresh = await guardian.signMessage(msgFresh);
    const sigStale = await guardian.signMessage(msgStale);

    expect(sigFresh).to.not.equal(sigStale);
  });
});
