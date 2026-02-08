const { PRIVATE_KEY, EXPLORER_API_KEY } = require("./config");
require("hardhat-contract-sizer");
require("@openzeppelin/hardhat-upgrades");

require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.20",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ],

    preferWasm: true, // 👈 avoids native solc
  },

  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
    disambiguatePaths: false,
  },

  networks: {
    testnet: {
      url: "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      gasPrice: 20000000000,
      accounts: [PRIVATE_KEY],
    },
    mainnet: {
      url: "https://bsc-dataseed.binance.org/",
      chainId: 56,
      gasPrice: 20000000000,
      accounts: [PRIVATE_KEY],
    },
    hardhat: {
      allowUnlimitedContractSize: true,
    },
  },
  etherscan: {
    apiKey: {
      mainnet: EXPLORER_API_KEY,
      bsc: EXPLORER_API_KEY,
      testnet: EXPLORER_API_KEY,
      bscTestnet: EXPLORER_API_KEY,
    },
    customChains: [
      {
        network: "testnet",
        chainId: 97,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=97&", // 👈 Custom API URL
          browserURL: "https://testnet.bscscan.com",
        },
      },
    ],
  },
};
