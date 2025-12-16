import { http } from "viem";
import { sepolia } from "wagmi/chains";
import { createConfig, type Config } from "wagmi";
import { getDefaultWallets } from "@rainbow-me/rainbowkit";

const INFURA_KEY = process.env.NEXT_PUBLIC_INFURA_KEY || "";

// Validate Infura key - valid keys are typically 32+ character alphanumeric strings
const isValidInfuraKey = INFURA_KEY && INFURA_KEY.length > 20 && /^[a-zA-Z0-9]+$/.test(INFURA_KEY);

const { connectors } = getDefaultWallets({
  appName: "Delayed MultiSig Wallet",
  projectId: "delayed-multisig",
});

// Try multiple public RPC endpoints for better reliability
const getSepoliaRPC = () => {
  if (isValidInfuraKey) {
    return http(`https://sepolia.infura.io/v3/${INFURA_KEY}`);
  }
  // Try Alchemy public RPC first (more reliable)
  return http("https://eth-sepolia.g.alchemy.com/v2/demo");
};

export const wagmiConfig: Config = createConfig({
  connectors,
  chains: [sepolia],
  transports: {
    [sepolia.id]: getSepoliaRPC(),
  },
  ssr: true,
});
