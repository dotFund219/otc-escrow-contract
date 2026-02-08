// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/OTCStructs.sol";
import "../libraries/OTCEnums.sol";

interface IOTCEscrow {
    event TradeOpened(
        uint256 indexed tradeId,
        uint256 indexed orderId,
        address indexed buyer
    );
    event DeliverySubmitted(uint256 indexed tradeId, string txid);
    event ReceiptConfirmed(uint256 indexed tradeId);
    event ReceiptRejected(uint256 indexed tradeId);
    event AdminResolved(
        uint256 indexed tradeId,
        OTCEnums.TradeStatus newStatus
    );

    function openTradeFromOrder(
        uint256 orderId,
        address buyer,
        address seller,
        address quoteToken,
        uint256 quoteAmount,
        uint256 feeAmount
    ) external returns (uint256 tradeId);

    function submitDeliveryTx(uint256 tradeId, string calldata txid) external;
    function confirmReceipt(uint256 tradeId) external;
    function rejectReceipt(uint256 tradeId) external;

    // Reserved: manager/admin can force resolve
    function adminForceRelease(uint256 tradeId) external;
    function adminForceRefund(uint256 tradeId) external;

    function getTrade(
        uint256 tradeId
    ) external view returns (OTCStructs.Trade memory);
}
