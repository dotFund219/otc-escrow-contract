// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library OTCEnums {
    enum OrderStatus {
        NONE,
        OPEN,
        TAKEN,
        CANCELLED
    }

    enum TradeStatus {
        NONE,
        AWAITING_DELIVERY, // Buyer deposited stable + fee
        DELIVERED_PENDING_CONFIRM, // Seller submitted TXID
        DISPUTE_PENDING, // Buyer rejected, admin must resolve
        RELEASED, // Funds released to seller
        REFUNDED // Funds refunded to buyer
    }
}
