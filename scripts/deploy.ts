import "@nomicfoundation/hardhat-toolbox";
import pkg from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

const { ethers } = pkg;

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("📤 Deploying with signer:", signer.address);

  const owners = [
    "0xe5fDA4B5DFC9cF0e5D4E6387eb7D9a8D9e6B16d0",  // Account 1
    "0x66e46455Cd0cFCf5860B737Ec9Fd1108cCb33943", // Owner 2
  ];
  const threshold = 2;
  const minDelay = 60;
  const guardian = owners[0];

  const Factory = await ethers.getContractFactory("DelayedExecutionMultiSig");
  const contract = await Factory.deploy(owners, threshold, minDelay, guardian);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("✅ Contract deployed to:", address);
}

main().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exitCode = 1;
});
