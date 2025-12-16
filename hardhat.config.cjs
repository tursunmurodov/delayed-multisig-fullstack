require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-verify");
require("@typechain/hardhat");
require("dotenv").config();

/** Load .env variables */
const { SEPOLIA_RPC_URL, PRIVATE_KEY, ETHERSCAN_API_KEY } = process.env;

/** @type import("hardhat/config").HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    hardhat: {},
    localhost: {
      url: "http://127.0.0.1:8545"
    },
    sepolia: SEPOLIA_RPC_URL && PRIVATE_KEY
      ? {
          url: SEPOLIA_RPC_URL,
          accounts: [PRIVATE_KEY],
          chainId: 11155111
        }
      : undefined
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY || ""
  },
  typechain: {
    outDir: "typechain",
    target: "ethers-v6"
  }
};
