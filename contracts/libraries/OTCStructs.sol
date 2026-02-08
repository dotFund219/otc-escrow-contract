// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OTCEnums.sol";

library OTCStructs {
    struct AssetConfig {
        bool enabled;
        address chainlinkFeed; // AggregatorV3
        uint8 feedDecimals;
    }

    struct Order {
        uint256 id;
        address seller;
        bytes32 sellAsset; // "BTC" / "ETH"
        uint256 sellAmount; // in wei-like units decided by frontend convention (ETH wei). For BTC, also treat as 1e18-based unit offchain.
        address quoteToken; // USDT/USDC ERC20 address
        uint256 quoteAmount; // stable amount required (excluding fee), locked at creation
        uint256 createdAt;
        OTCEnums.OrderStatus status;
        uint256 takenTradeId; // 0 if not taken
    }

    struct Trade {
        uint256 id;
        uint256 orderId;
        address buyer;
        address seller;
        address quoteToken;
        uint256 quoteAmount; // stable amount to seller
        uint256 feeAmount; // stable fee to treasury
        string deliveryTxId; // proof placeholder
        uint256 createdAt;
        uint256 deliveredAt;
        OTCEnums.TradeStatus status;
    }
}
