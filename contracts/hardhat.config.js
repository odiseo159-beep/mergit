import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import { readFileSync, existsSync } from "node:fs";

// La clave de despliegue vive fuera del proyecto, en mergit/WALLETS.secret.json.
// Nunca se commitea ni se imprime.
const SECRETS = new URL("../WALLETS.secret.json", import.meta.url);
const deployerKey = existsSync(SECRETS)
  ? JSON.parse(readFileSync(SECRETS, "utf8")).deployer.privateKey
  : undefined;

export default {
  plugins: [hardhatToolboxViem],

  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },

  networks: {
    hardhatMainnet: { type: "edr-simulated", chainType: "l1" },

    // GIWA Sepolia — L2 sobre Ethereum Sepolia (OP Stack)
    giwaSepolia: {
      type: "http",
      chainType: "op",
      url: "https://sepolia-rpc.giwa.io",
      chainId: 91342,
      accounts: deployerKey ? [deployerKey] : [],
    },
  },

  // Hardhat no trae GIWA en su catálogo de chains: se la describimos nosotros
  // para que `hardhat verify` sepa contra qué explorer publicar el código.
  chainDescriptors: {
    91342: {
      name: "GIWA Sepolia",
      chainType: "op",
      blockExplorers: {
        blockscout: {
          name: "GIWA Sepolia Explorer",
          url: "https://sepolia-explorer.giwa.io",
          apiUrl: "https://sepolia-explorer.giwa.io/api",
        },
      },
    },
  },

  verify: {
    blockscout: {
      enabled: true,
    },
    etherscan: {
      enabled: false,
    },
  },
};
