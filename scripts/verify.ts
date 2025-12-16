import pkg from "hardhat";
const { run } = pkg;

async function main() {
  const contractAddress = "0xA864F9c5fc3EeDe3F95f943983998ad48da75Ae9";
  const owners = ["0xe5fDA4B5DFC9cF0e5D4E6387eb7D9a8D9e6B16d0"];
  const threshold = 1;
  const minDelay = 60;
  const guardian = "0xe5fDA4B5DFC9cF0e5D4E6387eb7D9a8D9e6B16d0";

  await run("verify:verify", {
    address: contractAddress,
    constructorArguments: [owners, threshold, minDelay, guardian],
  });
}

main().catch((error) => {
  console.error("❌ Verification failed:", error.message);
  process.exit(1);
});
