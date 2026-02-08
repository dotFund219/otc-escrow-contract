require("dotenv").config();
const hre = require("hardhat");

function b32(s) {
  return hre.ethers.encodeBytes32String(s);
}

function parseCsvAddresses(csv) {
  if (!csv) return [];
  return csv
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const TREASURY = process.env.TREASURY || deployer.address;

  const FEE_BPS = process.env.FEE_BPS ? Number(process.env.FEE_BPS) : 30;
  const SPREAD_BPS = process.env.SPREAD_BPS
    ? Number(process.env.SPREAD_BPS)
    : 20;

  const BTC_PRICE = process.env.BTC_PRICE
    ? BigInt(process.env.BTC_PRICE)
    : 60000n;
  const ETH_PRICE = process.env.ETH_PRICE
    ? BigInt(process.env.ETH_PRICE)
    : 3000n;

  // Mint settings (human units with 6 decimals for our mock stablecoins)
  const mintToList = parseCsvAddresses(process.env.MINT_TO);
  const mintUsdtHuman = process.env.MINT_USDT
    ? BigInt(process.env.MINT_USDT)
    : 10000n;
  const mintUsdcHuman = process.env.MINT_USDC
    ? BigInt(process.env.MINT_USDC)
    : 10000n;

  // ---------------------------------------
  // 1) Deploy Mock USDT / USDC (mintable)
  // ---------------------------------------
  const MockERC20 = await hre.ethers.getContractFactory("MockERC20");

  const usdt = await MockERC20.deploy("Mock USDT", "USDT", 6);
  await usdt.waitForDeployment();

  const usdc = await MockERC20.deploy("Mock USDC", "USDC", 6);
  await usdc.waitForDeployment();

  console.log("Mock USDT:", await usdt.getAddress());
  console.log("Mock USDC:", await usdc.getAddress());

  // ---------------------------------------
  // 2) Deploy Mock Chainlink Feeds
  // ---------------------------------------
  const MockV3 = await hre.ethers.getContractFactory("MockV3Aggregator");

  // Chainlink typically uses 8 decimals for USD feeds
  const btcFeed = await MockV3.deploy(8, BTC_PRICE * 10n ** 8n);
  await btcFeed.waitForDeployment();

  const ethFeed = await MockV3.deploy(8, ETH_PRICE * 10n ** 8n);
  await ethFeed.waitForDeployment();

  console.log(
    "Mock BTC/USD feed:",
    await btcFeed.getAddress(),
    "price:",
    BTC_PRICE.toString(),
  );
  console.log(
    "Mock ETH/USD feed:",
    await ethFeed.getAddress(),
    "price:",
    ETH_PRICE.toString(),
  );

  // ---------------------------------------
  // 3) Deploy Core Contracts
  // ---------------------------------------
  const OTCAdmin = await hre.ethers.getContractFactory("OTCAdmin");
  const admin = await OTCAdmin.deploy(deployer.address);
  await admin.waitForDeployment();
  console.log("OTCAdmin:", await admin.getAddress());

  const OTCConfig = await hre.ethers.getContractFactory("OTCConfig");
  const config = await OTCConfig.deploy(deployer.address, TREASURY);
  await config.waitForDeployment();
  console.log("OTCConfig:", await config.getAddress());

  const OTCOrders = await hre.ethers.getContractFactory("OTCOrders");
  const orders = await OTCOrders.deploy(
    deployer.address,
    await admin.getAddress(),
    await config.getAddress(),
  );
  await orders.waitForDeployment();
  console.log("OTCOrders:", await orders.getAddress());

  const OTCEscrow = await hre.ethers.getContractFactory("OTCEscrow");
  const escrow = await OTCEscrow.deploy(
    await orders.getAddress(),
    await admin.getAddress(),
    await config.getAddress(),
  );
  await escrow.waitForDeployment();
  console.log("OTCEscrow:", await escrow.getAddress());

  // Wire Orders -> Escrow
  console.log("Wiring Orders.setEscrow...");
  await (await orders.setEscrow(await escrow.getAddress())).wait();
  console.log("  done");

  // ---------------------------------------
  // 4) Configure Config (fee/spread/quotes/assets)
  // ---------------------------------------
  console.log("Configuring...");
  await (await config.setFeeBps(FEE_BPS)).wait();
  await (await config.setSpreadBps(SPREAD_BPS)).wait();

  await (await config.setQuoteToken(await usdt.getAddress(), true)).wait();
  await (await config.setQuoteToken(await usdc.getAddress(), true)).wait();

  await (
    await config.setAsset(b32("BTC"), await btcFeed.getAddress(), true)
  ).wait();
  await (
    await config.setAsset(b32("ETH"), await ethFeed.getAddress(), true)
  ).wait();

  console.log("  feeBps   :", FEE_BPS);
  console.log("  spreadBps:", SPREAD_BPS);
  console.log("  treasury :", TREASURY);

  // ---------------------------------------
  // 5) Mint test assets to addresses
  // ---------------------------------------
  // Always mint to deployer, plus any MINT_TO list
  const targets = Array.from(new Set([deployer.address, ...mintToList]));

  const usdtAmount = mintUsdtHuman * 10n ** 6n;
  const usdcAmount = mintUsdcHuman * 10n ** 6n;

  console.log("Minting test tokens...");
  console.log("  Targets:", targets);
  console.log("  USDT each:", mintUsdtHuman.toString(), "(human)");
  console.log("  USDC each:", mintUsdcHuman.toString(), "(human)");

  for (const addr of targets) {
    const tx1 = await usdt.mint(addr, usdtAmount);
    await tx1.wait();
    const tx2 = await usdc.mint(addr, usdcAmount);
    await tx2.wait();
    console.log("  minted to:", addr);
  }

  console.log("\n✅ BNB Testnet FULL Deploy Complete");
  console.log("Treasury:", TREASURY);
  console.log("USDT    :", await usdt.getAddress());
  console.log("USDC    :", await usdc.getAddress());
  console.log("BTCFeed :", await btcFeed.getAddress());
  console.log("ETHFeed :", await ethFeed.getAddress());
  console.log("Admin   :", await admin.getAddress());
  console.log("Config  :", await config.getAddress());
  console.log("Orders  :", await orders.getAddress());
  console.log("Escrow  :", await escrow.getAddress());

  console.log("\nNext steps:");
  console.log(
    "1) In frontend/backend, use deployed USDT/USDC addresses above.",
  );
  console.log(
    "2) Buyer approves Orders contract to spend USDT/USDC before takeOrder().",
  );
  console.log(
    "3) You can update oracle price via MockV3Aggregator.updateAnswer(newPrice).",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
