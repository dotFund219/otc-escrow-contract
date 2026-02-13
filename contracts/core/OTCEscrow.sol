// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IOTCEscrow.sol";
import "../libraries/OTCStructs.sol";
import "../libraries/OTCEnums.sol";
import "../libraries/OTCErrors.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

contract OTCEscrow is IOTCEscrow {
    address public immutable ordersContract;
    address public adminContract;
    address public configContract;

    uint256 public nextTradeId = 1;
    mapping(uint256 => OTCStructs.Trade) private trades;

    // minimal reentrancy guard
    uint256 private locked = 1;
    modifier nonReentrant() {
        require(locked == 1, "reentrancy");
        locked = 2;
        _;
        locked = 1;
    }

    modifier onlyOrders() {
        require(msg.sender == ordersContract, "only orders");
        _;
    }

    constructor(address _ordersContract, address _admin, address _config) {
        ordersContract = _ordersContract;
        adminContract = _admin;
        configContract = _config;
    }

    function openTradeFromOrder(
        uint256 orderId,
        address buyer,
        address seller,
        address sellToken,
        uint256 sellAmount,
        address quoteToken,
        uint256 quoteAmount,
        uint256 feeAmount
    ) external onlyOrders nonReentrant returns (uint256 tradeId) {
        if (quoteToken == address(0)) revert OTCErrors.InvalidToken();
        if (quoteAmount == 0) revert OTCErrors.InvalidAmount();

        tradeId = nextTradeId++;

        trades[tradeId] = OTCStructs.Trade({
            id: tradeId,
            orderId: orderId,
            buyer: buyer,
            seller: seller,
            sellToken: sellToken,
            sellAmount: sellAmount,
            quoteToken: quoteToken,
            quoteAmount: quoteAmount,
            feeAmount: feeAmount,
            deliveryTxId: "",
            createdAt: block.timestamp,
            deliveredAt: 0,
            status: OTCEnums.TradeStatus.AWAITING_DELIVERY
        });

        emit TradeOpened(tradeId, orderId, buyer);
    }

    function submitDeliveryTx(uint256 tradeId, string calldata txid) external {
        OTCStructs.Trade storage t = trades[tradeId];
        if (t.status != OTCEnums.TradeStatus.AWAITING_DELIVERY)
            revert OTCErrors.InvalidState();
        if (msg.sender != t.seller) revert OTCErrors.NotSeller();

        // Placeholder for future: checkLogisticsStatus() == true always
        require(_checkLogisticsStatus(txid), "logistics fail");

        t.deliveryTxId = txid;
        t.deliveredAt = block.timestamp;
        t.status = OTCEnums.TradeStatus.DELIVERED_PENDING_CONFIRM;

        emit DeliverySubmitted(tradeId, txid);
    }

    function confirmReceipt(uint256 tradeId) external nonReentrant {
        OTCStructs.Trade storage t = trades[tradeId];
        if (t.status != OTCEnums.TradeStatus.DELIVERED_PENDING_CONFIRM)
            revert OTCErrors.InvalidState();
        if (msg.sender != t.buyer) revert OTCErrors.NotBuyer();

        // Payout: quoteAmount to seller, feeAmount to treasury (pulled from config via call)
        address treasury = _treasury();
        _safeTransfer(t.quoteToken, t.seller, t.quoteAmount);
        if (t.feeAmount > 0) _safeTransfer(t.quoteToken, treasury, t.feeAmount);

        t.status = OTCEnums.TradeStatus.RELEASED;
        emit ReceiptConfirmed(tradeId);
    }

    function rejectReceipt(uint256 tradeId) external {
        OTCStructs.Trade storage t = trades[tradeId];
        if (t.status != OTCEnums.TradeStatus.DELIVERED_PENDING_CONFIRM)
            revert OTCErrors.InvalidState();
        if (msg.sender != t.buyer) revert OTCErrors.NotBuyer();

        t.status = OTCEnums.TradeStatus.DISPUTE_PENDING;
        emit ReceiptRejected(tradeId);
    }

    // Reserved: manager/admin "API" to force change trade state
    function adminForceRelease(uint256 tradeId) external nonReentrant {
        require(_isAdmin(msg.sender), "not admin");
        OTCStructs.Trade storage t = trades[tradeId];
        if (t.status != OTCEnums.TradeStatus.DISPUTE_PENDING)
            revert OTCErrors.InvalidState();

        address treasury = _treasury();
        _safeTransfer(t.quoteToken, t.seller, t.quoteAmount);
        if (t.feeAmount > 0) _safeTransfer(t.quoteToken, treasury, t.feeAmount);

        t.status = OTCEnums.TradeStatus.RELEASED;
        emit AdminResolved(tradeId, t.status);
    }

    function adminForceRefund(uint256 tradeId) external nonReentrant {
        require(_isAdmin(msg.sender), "not admin");
        OTCStructs.Trade storage t = trades[tradeId];
        if (t.status != OTCEnums.TradeStatus.DISPUTE_PENDING)
            revert OTCErrors.InvalidState();

        // Refund: quoteAmount + feeAmount to buyer
        _safeTransfer(t.quoteToken, t.buyer, t.quoteAmount + t.feeAmount);

        t.status = OTCEnums.TradeStatus.REFUNDED;
        emit AdminResolved(tradeId, t.status);
    }

    function getTrade(
        uint256 tradeId
    ) external view returns (OTCStructs.Trade memory) {
        return trades[tradeId];
    }

    // -------------------------
    // Placeholders / Internals
    // -------------------------

    function _checkLogisticsStatus(
        string calldata /*txid*/
    ) internal pure returns (bool) {
        return true; // Phase 1: always true
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        bool ok = IERC20(token).transfer(to, amount);
        if (!ok) revert OTCErrors.TransferFailed();
    }

    function _treasury() internal view returns (address treasury) {
        // read treasury from config with low-level staticcall to avoid interface plumbing
        (bool ok, bytes memory data) = configContract.staticcall(
            abi.encodeWithSignature("treasury()")
        );
        require(ok && data.length >= 32, "treasury read fail");
        treasury = abi.decode(data, (address));
    }

    function _isAdmin(address who) internal view returns (bool) {
        (bool ok, bytes memory data) = adminContract.staticcall(
            abi.encodeWithSignature("isAdmin(address)", who)
        );
        if (!ok || data.length < 32) return false;
        return abi.decode(data, (bool));
    }
}
