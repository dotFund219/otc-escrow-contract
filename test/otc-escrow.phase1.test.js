const { expect } = require("chai");
const { ethers } = require("hardhat");

function b32(s) {
  return ethers.encodeBytes32String(s);
}

describe("OTC Escrow Phase-1 (Happy path + Admin resolve)", function () {
  let owner, seller, buyer, treasury, other;
  let admin, config, orders, escrow;
  let usdt, usdc;
  let btcFeed, ethFeed;

  // helper: read trade
  async function getTrade(tradeId) {
    return await escrow.getTrade(tradeId);
  }

  beforeEach(async () => {
    [owner, seller, buyer, treasury, other] = await ethers.getSigners();

    // -----------------------
    // Deploy mocks
    // -----------------------
    const MockV3 = await ethers.getContractFactory("MockV3Aggregator");
    // 8 decimals feeds
    btcFeed = await MockV3.deploy(8, 60_000n * 10n ** 8n); // $60k
    await btcFeed.waitForDeployment();
    ethFeed = await MockV3.deploy(8, 3_000n * 10n ** 8n); // $3k
    await ethFeed.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdt = await MockERC20.deploy("Mock USDT", "USDT", 6);
    await usdt.waitForDeployment();
    usdc = await MockERC20.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();

    // -----------------------
    // Deploy core
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

    // wire
    await (
      await orders.connect(owner).setEscrow(await escrow.getAddress())
    ).wait();

    // configure config
    await (await config.connect(owner).setFeeBps(30)).wait(); // 0.30%
    await (await config.connect(owner).setSpreadBps(20)).wait(); // 0.20%
    await (
      await config.connect(owner).setQuoteToken(await usdt.getAddress(), true)
    ).wait();
    await (
      await config.connect(owner).setQuoteToken(await usdc.getAddress(), true)
    ).wait();
    await (
      await config
        .connect(owner)
        .setAsset(b32("BTC"), await btcFeed.getAddress(), true)
    ).wait();
    await (
      await config
        .connect(owner)
        .setAsset(b32("ETH"), await ethFeed.getAddress(), true)
    ).wait();
  });

  it("Happy path: createOrder -> takeOrder -> submitDeliveryTx -> confirmReceipt", async () => {
    // Seller creates order: sell 1 ETH (1e18 units), quote token USDT
    const sellAmount = 1n * 10n ** 18n;

    const txCreate = await orders
      .connect(seller)
      .createOrder(b32("ETH"), sellAmount, await usdt.getAddress());
    const rcCreate = await txCreate.wait();
    const orderId = rcCreate.logs.find(
      (l) => l.fragment?.name === "OrderCreated",
    ).args.orderId;

    // Read order to know locked quoteAmount
    const o = await orders.orders(orderId);
    const quoteAmount = o.quoteAmount; // NOTE: in this MVP it's 1e18-scaled "USD-like" output

    // Buyer mints and approves enough USDT for (quoteAmount + fee)
    // Fee = quoteAmount * 30 / 10000
    const feeAmount = (quoteAmount * 30n) / 10_000n;
    const total = quoteAmount + feeAmount;

    await (await usdt.mint(buyer.address, total)).wait();
    await (
      await usdt.connect(buyer).approve(await orders.getAddress(), total)
    ).wait();

    // Take order (pulls USDT to escrow, opens trade)
    const txTake = await orders.connect(buyer).takeOrder(orderId);
    const rcTake = await txTake.wait();
    const tradeId = rcTake.logs.find((l) => l.fragment?.name === "OrderTaken")
      .args.tradeId;

    // Verify escrow got the funds
    const escrowBal = await usdt.balanceOf(await escrow.getAddress());
    expect(escrowBal).to.equal(total);

    // Seller submits delivery txid
    await (
      await escrow.connect(seller).submitDeliveryTx(tradeId, "0xDEADBEEF_TXID")
    ).wait();

    // Buyer confirms receipt => funds released
    const sellerBefore = await usdt.balanceOf(seller.address);
    const treasuryBefore = await usdt.balanceOf(treasury.address);

    await (await escrow.connect(buyer).confirmReceipt(tradeId)).wait();

    const sellerAfter = await usdt.balanceOf(seller.address);
    const treasuryAfter = await usdt.balanceOf(treasury.address);

    expect(sellerAfter - sellerBefore).to.equal(quoteAmount);
    expect(treasuryAfter - treasuryBefore).to.equal(feeAmount);

    // Trade status = RELEASED (enum index depends on OTCEnums)
    const t = await getTrade(tradeId);
    // In our enum: RELEASED = 4
    expect(t.status).to.equal(4n);

    // Escrow drained (should be 0)
    const escrowBalAfter = await usdt.balanceOf(await escrow.getAddress());
    expect(escrowBalAfter).to.equal(0n);
  });

  it("Unhappy path: buyer rejects -> DISPUTE_PENDING -> adminForceRefund", async () => {
    const sellAmount = 2n * 10n ** 18n;

    const txCreate = await orders
      .connect(seller)
      .createOrder(b32("ETH"), sellAmount, await usdc.getAddress());
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

    // Buyer rejects -> DISPUTE_PENDING (enum index 3)
    await (await escrow.connect(buyer).rejectReceipt(tradeId)).wait();
    let t = await getTrade(tradeId);
    expect(t.status).to.equal(3n);

    const buyerBefore = await usdc.balanceOf(buyer.address);

    // Admin resolves (owner is admin by default in OTCAdmin)
    await (await escrow.connect(owner).adminForceRefund(tradeId)).wait();

    const buyerAfter = await usdc.balanceOf(buyer.address);
    expect(buyerAfter - buyerBefore).to.equal(total);

    t = await getTrade(tradeId);
    // REFUNDED = 5
    expect(t.status).to.equal(5n);
  });

  it("Unhappy path: buyer rejects -> adminForceRelease", async () => {
    const sellAmount = 1n * 10n ** 18n;

    const txCreate = await orders
      .connect(seller)
      .createOrder(b32("ETH"), sellAmount, await usdt.getAddress());
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

    // admin force release
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
      .createOrder(b32("ETH"), sellAmount, await usdt.getAddress());
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

    // other (not seller) tries submitDeliveryTx
    await expect(escrow.connect(other).submitDeliveryTx(tradeId, "0xTXID")).to
      .be.reverted;

    // seller submits properly
    await (
      await escrow.connect(seller).submitDeliveryTx(tradeId, "0xTXID")
    ).wait();

    // other (not buyer) tries confirm
    await expect(escrow.connect(other).confirmReceipt(tradeId)).to.be.reverted;
  });
});
