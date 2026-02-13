require("dotenv").config();
const hre = require("hardhat");

function parseCsvAddresses(csv) {
  if (!csv) return [];
  return csv
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

async function verifyIfNeeded(address, args) {
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments: args,
    });
    console.log("  ✓ verified:", address);
  } catch (e) {
    const msg = e.message || "";
    if (msg.includes("Already Verified") || msg.includes("already verified")) {
      console.log("  ✓ already verified:", address);
    } else {
      console.log("  ⚠ verify failed:", address);
      console.log("    reason:", msg);
    }
  }
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const TREASURY = process.env.TREASURY || deployer.address;

  const FEE_BPS = process.env.FEE_BPS ? Number(process.env.FEE_BPS) : 30;
  const SPREAD_BPS = process.env.SPREAD_BPS
    ? Number(process.env.SPREAD_BPS)
    : 20;

  // Prices (human) for mock feeds
  const WBTC_PRICE = process.env.WBTC_PRICE
    ? BigInt(process.env.WBTC_PRICE)
    : 60000n;
  const WETH_PRICE = process.env.WETH_PRICE
    ? BigInt(process.env.WETH_PRICE)
    : 3000n;

  const USDT_PRICE = process.env.USDT_PRICE
    ? BigInt(process.env.USDT_PRICE)
    : 1n;

  const USDC_PRICE = process.env.USDC_PRICE
    ? BigInt(process.env.USDC_PRICE)
    : 1n;

  // Mint settings (human units)
  const mintToList = parseCsvAddresses(process.env.MINT_TO);

  const mintUsdtHuman = process.env.MINT_USDT
    ? BigInt(process.env.MINT_USDT)
    : 10000n; // 6 dec
  const mintUsdcHuman = process.env.MINT_USDC
    ? BigInt(process.env.MINT_USDC)
    : 10000n; // 6 dec
  const mintWbtcHuman = process.env.MINT_WBTC
    ? BigInt(process.env.MINT_WBTC)
    : 1n; // 8 dec (1 WBTC)
  const mintWethHuman = process.env.MINT_WETH
    ? BigInt(process.env.MINT_WETH)
    : 10n; // 18 dec (10 WETH)

  // ---------------------------------------
  // 1) Deploy Mock Tokens (USDT/USDC/WBTC/WETH)
  // ---------------------------------------
  const MockERC20 = await hre.ethers.getContractFactory("MockERC20");

  const usdt = await MockERC20.deploy("Mock USDT", "USDT", 6);
  await usdt.waitForDeployment();

  const usdc = await MockERC20.deploy("Mock USDC", "USDC", 6);
  await usdc.waitForDeployment();

  const wbtc = await MockERC20.deploy("Mock WBTC", "WBTC", 8);
  await wbtc.waitForDeployment();

  const weth = await MockERC20.deploy("Mock WETH", "WETH", 18);
  await weth.waitForDeployment();

  console.log("Mock USDT:", await usdt.getAddress());
  console.log("Mock USDC:", await usdc.getAddress());
  console.log("Mock WBTC:", await wbtc.getAddress());
  console.log("Mock WETH:", await weth.getAddress());

  // ---------------------------------------
  // 2) Deploy Mock Chainlink Feeds (WBTC/USD, WETH/USD)
  // ---------------------------------------
  const MockV3 = await hre.ethers.getContractFactory("MockV3Aggregator");

  // Chainlink USD feeds often use 8 decimals
  const wbtcFeed = await MockV3.deploy(8, WBTC_PRICE * 10n ** 8n);
  await wbtcFeed.waitForDeployment();

  const wethFeed = await MockV3.deploy(8, WETH_PRICE * 10n ** 8n);
  await wethFeed.waitForDeployment();

  const usdtFeed = await MockV3.deploy(8, USDT_PRICE * 10n ** 8n); // $1.00
  await usdtFeed.waitForDeployment();

  const usdcFeed = await MockV3.deploy(8, USDC_PRICE * 10n ** 8n); // $1.00
  await usdcFeed.waitForDeployment();

  console.log(
    "Mock WBTC/USD feed:",
    await wbtcFeed.getAddress(),
    "price:",
    WBTC_PRICE.toString(),
  );
  console.log(
    "Mock WETH/USD feed:",
    await wethFeed.getAddress(),
    "price:",
    WETH_PRICE.toString(),
  );
  console.log(
    "Mock USDT/USD feed:",
    await usdtFeed.getAddress(),
    "price:",
    USDT_PRICE.toString(),
  );
  console.log(
    "Mock USDC/USD feed:",
    await usdcFeed.getAddress(),
    "price:",
    USDC_PRICE.toString(),
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
  // 4) Configure Config (fee/spread/tokens/assets)
  // ---------------------------------------
  console.log("Configuring...");
  await (await config.setFeeBps(FEE_BPS)).wait();
  await (await config.setSpreadBps(SPREAD_BPS)).wait();

  // ✅ Allow tokens (both sellToken and quoteToken can be any of these)
  // Adjust the function name depending on your updated Config contract.
  // Examples: setAllowedToken(token,bool) or setTokenAllowed(token,bool)
  await (await config.setQuoteToken(await usdt.getAddress(), true)).wait();
  await (await config.setQuoteToken(await usdc.getAddress(), true)).wait();
  await (await config.setQuoteToken(await wbtc.getAddress(), true)).wait();
  await (await config.setQuoteToken(await weth.getAddress(), true)).wait();

  // ✅ Price feeds for volatile tokens
  await (
    await config.setAsset(
      await wbtc.getAddress(),
      await wbtcFeed.getAddress(),
      true,
    )
  ).wait();
  await (
    await config.setAsset(
      await weth.getAddress(),
      await wethFeed.getAddress(),
      true,
    )
  ).wait();
  await (
    await config.setAsset(
      await usdt.getAddress(),
      await usdtFeed.getAddress(),
      true,
    )
  ).wait();
  await (
    await config.setAsset(
      await usdc.getAddress(),
      await usdcFeed.getAddress(),
      true,
    )
  ).wait();

  // (Optional) If you want to manage stablecoins via price feeds as well,
  // add something like setAsset(USDT, usdtFeed, true) here.
  // If you treat stables as fixed $1 in getOraclePrice(), you don't need setAsset for them.

  console.log("  feeBps   :", FEE_BPS);
  console.log("  spreadBps:", SPREAD_BPS);
  console.log("  treasury :", TREASURY);

  // ---------------------------------------
  // 5) Mint test tokens to addresses
  // ---------------------------------------
  const targets = Array.from(new Set([deployer.address, ...mintToList]));

  const usdtAmount = mintUsdtHuman * 10n ** 6n;
  const usdcAmount = mintUsdcHuman * 10n ** 6n;
  const wbtcAmount = mintWbtcHuman * 10n ** 8n;
  const wethAmount = mintWethHuman * 10n ** 18n;

  console.log("Minting test tokens...");
  console.log("  Targets:", targets);
  console.log("  USDT each:", mintUsdtHuman.toString(), "(human)");
  console.log("  USDC each:", mintUsdcHuman.toString(), "(human)");
  console.log("  WBTC each:", mintWbtcHuman.toString(), "(human)");
  console.log("  WETH each:", mintWethHuman.toString(), "(human)");

  for (const addr of targets) {
    await (await usdt.mint(addr, usdtAmount)).wait();
    await (await usdc.mint(addr, usdcAmount)).wait();
    await (await wbtc.mint(addr, wbtcAmount)).wait();
    await (await weth.mint(addr, wethAmount)).wait();
    console.log("  minted to:", addr);
  }

  console.log("\n✅ FULL Deploy Complete");
  console.log("Treasury:", TREASURY);
  console.log("USDT    :", await usdt.getAddress());
  console.log("USDC    :", await usdc.getAddress());
  console.log("WBTC    :", await wbtc.getAddress());
  console.log("WETH    :", await weth.getAddress());
  console.log("WBTCFeed:", await wbtcFeed.getAddress());
  console.log("WETHFeed:", await wethFeed.getAddress());
  console.log("USDTFeed:", await usdtFeed.getAddress());
  console.log("USDCFeed:", await usdcFeed.getAddress());
  console.log("Admin   :", await admin.getAddress());
  console.log("Config  :", await config.getAddress());
  console.log("Orders  :", await orders.getAddress());
  console.log("Escrow  :", await escrow.getAddress());

  // ---------------------------------------
  // 6) Verify contracts
  // ---------------------------------------
  console.log("\nVerifying contracts...");

  await verifyIfNeeded(await admin.getAddress(), [deployer.address]);
  await verifyIfNeeded(await config.getAddress(), [deployer.address, TREASURY]);
  await verifyIfNeeded(await orders.getAddress(), [
    deployer.address,
    await admin.getAddress(),
    await config.getAddress(),
  ]);
  await verifyIfNeeded(await escrow.getAddress(), [
    await orders.getAddress(),
    await admin.getAddress(),
    await config.getAddress(),
  ]);

  console.log("\nNext steps:");
  console.log(
    "1) Frontend: use these token addresses as sellToken/quoteToken candidates.",
  );
  console.log(
    "2) Buyer approves Orders to spend quoteToken before takeOrder(). (Orders.transferFrom -> Escrow)",
  );
  console.log(
    "3) Seller sends sellToken directly to buyer off escrow, then submitDeliveryTx(txid).",
  );
  console.log(
    "4) You can update mock feed via MockV3Aggregator.updateAnswer(newPrice).",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
