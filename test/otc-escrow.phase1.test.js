const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("OTC Escrow Phase-1 (Token-based Orders; seller delivers off-escrow)", function () {
  let owner, seller, buyer, treasury, other;
  let admin, config, orders, escrow;

  let usdt, usdc, wbtc, weth;
  let usdtFeed, usdcFeed, wbtcFeed, wethFeed;

  async function getTrade(tradeId) {
    return await escrow.getTrade(tradeId);
  }

  beforeEach(async () => {
    [owner, seller, buyer, treasury, other] = await ethers.getSigners();

    // -----------------------
    // Deploy mocks
    // -----------------------
    const MockV3 = await ethers.getContractFactory("MockV3Aggregator");
    // 8-decimal price feeds
    usdtFeed = await MockV3.deploy(8, 1n * 10n ** 8n); // $1.00
    await usdtFeed.waitForDeployment();

    usdcFeed = await MockV3.deploy(8, 1n * 10n ** 8n); // $1.00
    await usdcFeed.waitForDeployment();

    wbtcFeed = await MockV3.deploy(8, 60_000n * 10n ** 8n); // $60k
    await wbtcFeed.waitForDeployment();

    wethFeed = await MockV3.deploy(8, 3_000n * 10n ** 8n); // $3k
    await wethFeed.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdt = await MockERC20.deploy("Mock USDT", "USDT", 6);
    await usdt.waitForDeployment();

    usdc = await MockERC20.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();

    wbtc = await MockERC20.deploy("Mock WBTC", "WBTC", 8);
    await wbtc.waitForDeployment();

    weth = await MockERC20.deploy("Mock WETH", "WETH", 18);
    await weth.waitForDeployment();

    // -----------------------
    // Deploy core contracts
    // -----------------------
    const OTCAdmin = await ethers.getContractFactory("OTCAdmin");
    admin = await OTCAdmin.deploy(owner.address);
    await admin.waitForDeployment();

    const OTCConfig = await ethers.getContractFactory("OTCConfig");
    config = await OTCConfig.deploy(owner.address, treasury.address);
    await config.waitForDeployment();

    const OTCOrders = await ethers.getContractFactory("OTCOrders");
    orders = await OTCOrders.deploy(
      owner.address,
      await admin.getAddress(),
      await config.getAddress(),
    );
    await orders.waitForDeployment();

    const OTCEscrow = await ethers.getContractFactory("OTCEscrow");
    escrow = await OTCEscrow.deploy(
      await orders.getAddress(),
      await admin.getAddress(),
      await config.getAddress(),
    );
    await escrow.waitForDeployment();

    // Wire Orders -> Escrow
    await (
      await orders.connect(owner).setEscrow(await escrow.getAddress())
    ).wait();

    // -----------------------
    // Configure config
    // -----------------------
    await (await config.connect(owner).setFeeBps(30)).wait(); // 0.30%
    await (await config.connect(owner).setSpreadBps(20)).wait(); // 0.20%

    // ✅ Allow tokens (both sellToken and quoteToken must be allowed)
    await (
      await config.connect(owner).setQuoteToken(await usdt.getAddress(), true)
    ).wait();
    await (
      await config.connect(owner).setQuoteToken(await usdc.getAddress(), true)
    ).wait();
    await (
      await config.connect(owner).setQuoteToken(await wbtc.getAddress(), true)
    ).wait();
    await (
      await config.connect(owner).setQuoteToken(await weth.getAddress(), true)
    ).wait();

    // ✅ Set assets (token -> feed)
    await (
      await config
        .connect(owner)
        .setAsset(await usdt.getAddress(), await usdtFeed.getAddress(), true)
    ).wait();
    await (
      await config
        .connect(owner)
        .setAsset(await usdc.getAddress(), await usdcFeed.getAddress(), true)
    ).wait();
    await (
      await config
        .connect(owner)
        .setAsset(await wbtc.getAddress(), await wbtcFeed.getAddress(), true)
    ).wait();
    await (
      await config
        .connect(owner)
        .setAsset(await weth.getAddress(), await wethFeed.getAddress(), true)
    ).wait();
  });

  it("Happy path: createOrder -> takeOrder -> submitDeliveryTx -> confirmReceipt", async () => {
    // Seller creates an order: sell 1 WETH (18 decimals), quote token USDT (6 decimals)
    const sellAmount = 1n * 10n ** 18n;

    const txCreate = await orders
      .connect(seller)
      .createOrder(
        await weth.getAddress(),
        sellAmount,
        await usdt.getAddress(),
      );

    const rcCreate = await txCreate.wait();
    const orderId = rcCreate.logs.find(
      (l) => l.fragment?.name === "OrderCreated",
    ).args.orderId;

    // Read order to get the locked quoteAmount (in quoteToken decimals, e.g. 6 for USDT)
    const o = await orders.orders(orderId);
    const quoteAmount = o.quoteAmount;

    // Fee = quoteAmount * 30 / 10000
    const feeAmount = (quoteAmount * 30n) / 10_000n;
    const total = quoteAmount + feeAmount;

    // Buyer mints and approves enough USDT
    await (await usdt.mint(buyer.address, total)).wait();
    await (
      await usdt.connect(buyer).approve(await orders.getAddress(), total)
    ).wait();

    // Take the order
    const txTake = await orders.connect(buyer).takeOrder(orderId);
    const rcTake = await txTake.wait();
    const tradeId = rcTake.logs.find((l) => l.fragment?.name === "OrderTaken")
      .args.tradeId;

    // Escrow received the funds
    const escrowBal = await usdt.balanceOf(await escrow.getAddress());
    expect(escrowBal).to.equal(total);

    // Seller submits a delivery txid (seller delivers sellToken directly to buyer off-escrow)
    await (
      await escrow.connect(seller).submitDeliveryTx(tradeId, "0xDEADBEEF_TXID")
    ).wait();

    // Buyer confirms receipt => funds are released
    const sellerBefore = await usdt.balanceOf(seller.address);
    const treasuryBefore = await usdt.balanceOf(treasury.address);

    await (await escrow.connect(buyer).confirmReceipt(tradeId)).wait();

    const sellerAfter = await usdt.balanceOf(seller.address);
    const treasuryAfter = await usdt.balanceOf(treasury.address);

    expect(sellerAfter - sellerBefore).to.equal(quoteAmount);
    expect(treasuryAfter - treasuryBefore).to.equal(feeAmount);

    // Trade status = RELEASED (enum: NONE=0, AWAITING_DELIVERY=1, DELIVERED_PENDING_CONFIRM=2, DISPUTE_PENDING=3, RELEASED=4, REFUNDED=5)
    const t = await getTrade(tradeId);
    expect(t.status).to.equal(4n);

    // Escrow drained
    const escrowBalAfter = await usdt.balanceOf(await escrow.getAddress());
    expect(escrowBalAfter).to.equal(0n);
  });

  it("Unhappy path: buyer rejects -> DISPUTE_PENDING -> adminForceRefund", async () => {
    // Sell 2 WETH, quote USDC
    const sellAmount = 2n * 10n ** 18n;

    const txCreate = await orders
      .connect(seller)
      .createOrder(
        await weth.getAddress(),
        sellAmount,
        await usdc.getAddress(),
      );

    const rcCreate = await txCreate.wait();
    const orderId = rcCreate.logs.find(
      (l) => l.fragment?.name === "OrderCreated",
    ).args.orderId;

    const o = await orders.orders(orderId);
    const quoteAmount = o.quoteAmount;

    const feeAmount = (quoteAmount * 30n) / 10_000n;
    const total = quoteAmount + feeAmount;

    await (await usdc.mint(buyer.address, total)).wait();
    await (
      await usdc.connect(buyer).approve(await orders.getAddress(), total)
    ).wait();

    const txTake = await orders.connect(buyer).takeOrder(orderId);
    const rcTake = await txTake.wait();
    const tradeId = rcTake.logs.find((l) => l.fragment?.name === "OrderTaken")
      .args.tradeId;

    await (
      await escrow.connect(seller).submitDeliveryTx(tradeId, "0xTXID")
    ).wait();

    // Buyer rejects -> DISPUTE_PENDING = 3
    await (await escrow.connect(buyer).rejectReceipt(tradeId)).wait();
    let t = await getTrade(tradeId);
    expect(t.status).to.equal(3n);

    const buyerBefore = await usdc.balanceOf(buyer.address);

    // Admin resolves refund (owner is admin by default)
    await (await escrow.connect(owner).adminForceRefund(tradeId)).wait();

    const buyerAfter = await usdc.balanceOf(buyer.address);
    expect(buyerAfter - buyerBefore).to.equal(total);

    t = await getTrade(tradeId);
    expect(t.status).to.equal(5n); // REFUNDED
  });

  it("Unhappy path: buyer rejects -> adminForceRelease", async () => {
    const sellAmount = 1n * 10n ** 18n;

    const txCreate = await orders
      .connect(seller)
      .createOrder(
        await weth.getAddress(),
        sellAmount,
        await usdt.getAddress(),
      );

    const rcCreate = await txCreate.wait();
    const orderId = rcCreate.logs.find(
      (l) => l.fragment?.name === "OrderCreated",
    ).args.orderId;

    const o = await orders.orders(orderId);
    const quoteAmount = o.quoteAmount;

    const feeAmount = (quoteAmount * 30n) / 10_000n;
    const total = quoteAmount + feeAmount;

    await (await usdt.mint(buyer.address, total)).wait();
    await (
      await usdt.connect(buyer).approve(await orders.getAddress(), total)
    ).wait();

    const txTake = await orders.connect(buyer).takeOrder(orderId);
    const rcTake = await txTake.wait();
    const tradeId = rcTake.logs.find((l) => l.fragment?.name === "OrderTaken")
      .args.tradeId;

    await (
      await escrow.connect(seller).submitDeliveryTx(tradeId, "0xTXID")
    ).wait();
    await (await escrow.connect(buyer).rejectReceipt(tradeId)).wait();

    const sellerBefore = await usdt.balanceOf(seller.address);
    const treasuryBefore = await usdt.balanceOf(treasury.address);

    // Admin force release
    await (await escrow.connect(owner).adminForceRelease(tradeId)).wait();

    const sellerAfter = await usdt.balanceOf(seller.address);
    const treasuryAfter = await usdt.balanceOf(treasury.address);

    expect(sellerAfter - sellerBefore).to.equal(quoteAmount);
    expect(treasuryAfter - treasuryBefore).to.equal(feeAmount);

    const t = await getTrade(tradeId);
    expect(t.status).to.equal(4n); // RELEASED
  });

  it("Guards: non-seller cannot submitDeliveryTx, non-buyer cannot confirm", async () => {
    const sellAmount = 1n * 10n ** 18n;

    const txCreate = await orders
      .connect(seller)
      .createOrder(
        await weth.getAddress(),
        sellAmount,
        await usdt.getAddress(),
      );

    const rcCreate = await txCreate.wait();
    const orderId = rcCreate.logs.find(
      (l) => l.fragment?.name === "OrderCreated",
    ).args.orderId;

    const o = await orders.orders(orderId);
    const quoteAmount = o.quoteAmount;

    const feeAmount = (quoteAmount * 30n) / 10_000n;
    const total = quoteAmount + feeAmount;

    await (await usdt.mint(buyer.address, total)).wait();
    await (
      await usdt.connect(buyer).approve(await orders.getAddress(), total)
    ).wait();

    const txTake = await orders.connect(buyer).takeOrder(orderId);
    const rcTake = await txTake.wait();
    const tradeId = rcTake.logs.find((l) => l.fragment?.name === "OrderTaken")
      .args.tradeId;

    // Other account (not seller) tries to submitDeliveryTx
    await expect(escrow.connect(other).submitDeliveryTx(tradeId, "0xTXID")).to
      .be.reverted;

    // Seller submits properly
    await (
      await escrow.connect(seller).submitDeliveryTx(tradeId, "0xTXID")
    ).wait();

    // Other account (not buyer) tries to confirmReceipt
    await expect(escrow.connect(other).confirmReceipt(tradeId)).to.be.reverted;
  });

  it("Extra: supports WBTC->USDT pricing path (sanity)", async () => {
    // Sell 0.1 WBTC (8 decimals)
    const sellAmount = 10_000_000n; // 0.1 * 1e8

    const txCreate = await orders
      .connect(seller)
      .createOrder(
        await wbtc.getAddress(),
        sellAmount,
        await usdt.getAddress(),
      );

    const rcCreate = await txCreate.wait();
    const orderId = rcCreate.logs.find(
      (l) => l.fragment?.name === "OrderCreated",
    ).args.orderId;

    const o = await orders.orders(orderId);
    expect(o[2]).to.equal(await wbtc.getAddress());
    expect(o.quoteToken).to.equal(await usdt.getAddress());
    expect(o.quoteAmount).to.be.gt(0n);
  });
});
