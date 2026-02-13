# OTC Escrow — README

## Overview

A minimal OTC escrow system enabling off-chain delivery with on-chain escrow. Sellers list assets priced by oracle feeds; buyers lock quote tokens in escrow, sellers submit delivery proof, buyers confirm to release funds or raise dispute.

## Key Contracts

- `OTCOrders`: create and take orders, calculates quote amounts using oracle prices and spread.
- `OTCEscrow`: holds quote funds (ERC20 or native ETH), manages trade lifecycle (open, deliver, confirm, dispute, admin resolve).
- `OTCConfig`: register assets (oracle feeds), configure allowed quote tokens, treasury, fees and spread.
- `OTCAdmin`: manages user/admin access (access control).

## Supported Assets & Quote Tokens

- Sell assets: configured via `OTCConfig.setAsset(bytes32 symbol, address feed, bool enabled)` (examples: "WBTC", "ETH", "BTC").
- Quote tokens: configured via `OTCConfig.setQuoteToken(address token, bool allowed)`. Can be ERC20 (WBTC/USDT/USDC) or native ETH using `address(0)`.
- Native ETH is represented by `address(0)`; when `quoteToken == address(0)` buyers must send `msg.value` equal to `quoteAmount + fee` when calling `takeOrder`.

## Usage (high level)

- Seller creates order:
  \```js
  const symbol = ethers.encodeBytes32String("WBTC");
  await orders.connect(seller).createOrder(symbol, sellAmount, quoteTokenAddress);
  \```
- Buyer takes order (ERC20 quote):
  \```js
  await erc20.connect(buyer).mint(buyer.address, total);
  await erc20.connect(buyer).approve(orders.address, total);
  await orders.connect(buyer).takeOrder(orderId);
  \```
- Buyer takes order (ETH quote):
  \```js
  await orders.connect(buyer).takeOrder(orderId, { value: total });
  \```
- Seller submits delivery proof:
  \```js
  await escrow.connect(seller).submitDeliveryTx(tradeId, "0xTXID");
  \```
- Buyer confirms receipt:
  \```js
  await escrow.connect(buyer).confirmReceipt(tradeId);
  \```
- Buyer rejects (dispute):
  \```js
  await escrow.connect(buyer).rejectReceipt(tradeId);
  \```
- Admin resolves:
  \```js
  await escrow.connect(admin).adminForceRelease(tradeId);
  await escrow.connect(admin).adminForceRefund(tradeId);
  \```

## Pricing & Decimals

- Orders call `OTCConfig.getOraclePrice(bytes32 symbol)` to get price and feed decimals.
- `OTCOrders._calcQuoteAmount` returns quote amounts adjusted for token decimals (handles 6/18 etc.) and applies `spreadBps`.

## Configuration / Deployment Notes

- Register oracle feeds and enable assets:
  \```js
  await config.setAsset(ethers.encodeBytes32String("WBTC"), wbtcFeedAddr, true);
  await config.setAsset(ethers.encodeBytes32String("ETH"), ethFeedAddr, true);
  \```
- Enable quote tokens:
  \```js
  await config.setQuoteToken(wbtcAddress, true);
  await config.setQuoteToken(usdtAddress, true);
  await config.setQuoteToken(usdcAddress, true);
  \```
- ETH quote: seller uses `quoteToken = ethers.constants.AddressZero` when creating order.
- Set treasury and fees:
  \```js
  await config.setTreasury(treasuryAddress);
  await config.setFeeBps(30); // 0.30%
  await config.setSpreadBps(20); // 0.20%
  \```
- Wire contracts:
  \```js
  await orders.setEscrow(escrow.address);
  \```

## Tests

Run unit tests:
\``` bash
npx hardhat test
\```
To test ETH quote flow, add a test where  `createOrder(..., quoteToken = ethers.constants.AddressZero)`and call`takeOrder`with`{ value: total }`.

## Safety Notes

- `address(0)` denotes native ETH; take care when calling `takeOrder` and when configuring `quoteToken`.
- `OTCConfig` controls which sell-assets and quote tokens are enabled — ensure WBTC/USDT/USDC/ETH are enabled as needed.
- `_safeTransfer` in escrow supports both ERC20 and ETH transfers.

## Deploy Script

```bash
npx hardhat run scripts/deploy.js --network <network-name>
```

Example deployment order:

1. Deploy `OTCAdmin`
2. Deploy `OTCConfig` with admin address
3. Deploy `OTCOrders` with config address
4. Deploy `OTCEscrow` with config address
5. Wire contracts: `orders.setEscrow(escrow.address)`
6. Register assets, quote tokens, treasury, fees, and spread via `OTCConfig`

See `scripts/deploy.js` for full implementation.
