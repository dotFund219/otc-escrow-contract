// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/OTCStructs.sol";
import "../libraries/OTCEnums.sol";
import "../libraries/OTCErrors.sol";
import "../libraries/OTCMath.sol";
import "../interfaces/IOTCEscrow.sol";

interface IERC20Like {
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
}

interface IAdminLike {
    function assertActiveUser(address user) external view;
}

interface IConfigLike {
    function allowedQuoteTokens(address token) external view returns (bool);
    function feeBps() external view returns (uint256);
    function spreadBps() external view returns (uint256);
    function getOraclePrice(
        bytes32 symbol
    ) external view returns (uint256 price, uint8 decimals_);
}

contract OTCOrders {
    using OTCMath for uint256;

    address public owner;
    address public admin;
    address public config;
    address public escrow;

    uint256 public nextOrderId = 1;
    mapping(uint256 => OTCStructs.Order) public orders;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed seller,
        bytes32 sellAsset,
        uint256 sellAmount,
        address quoteToken,
        uint256 quoteAmount
    );
    event OrderCancelled(uint256 indexed orderId);
    event OrderTaken(
        uint256 indexed orderId,
        uint256 indexed tradeId,
        address indexed buyer
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert OTCErrors.NotOwner();
        _;
    }

    constructor(address _owner, address _admin, address _config) {
        owner = _owner;
        admin = _admin;
        config = _config;
    }

    function setEscrow(address _escrow) external onlyOwner {
        require(_escrow != address(0), "zero");
        escrow = _escrow;
    }

    // Seller creates order: sell BTC/ETH, receive USDT/USDC
    function createOrder(
        bytes32 sellAsset, // "BTC" or "ETH"
        uint256 sellAmount, // in 1e18-based unit agreed by frontend
        address quoteToken // USDT/USDC
    ) external returns (uint256 orderId) {
        IAdminLike(admin).assertActiveUser(msg.sender);
        if (sellAmount == 0) revert OTCErrors.InvalidAmount();
        if (!IConfigLike(config).allowedQuoteTokens(quoteToken))
            revert OTCErrors.InvalidToken();

        // price lock at creation
        uint256 quoteAmount = _calcQuoteAmount(sellAsset, sellAmount);

        orderId = nextOrderId++;

        orders[orderId] = OTCStructs.Order({
            id: orderId,
            seller: msg.sender,
            sellAsset: sellAsset,
            sellAmount: sellAmount,
            quoteToken: quoteToken,
            quoteAmount: quoteAmount,
            createdAt: block.timestamp,
            status: OTCEnums.OrderStatus.OPEN,
            takenTradeId: 0
        });

        emit OrderCreated(
            orderId,
            msg.sender,
            sellAsset,
            sellAmount,
            quoteToken,
            quoteAmount
        );
    }

    function cancelOrder(uint256 orderId) external {
        OTCStructs.Order storage o = orders[orderId];
        if (o.status != OTCEnums.OrderStatus.OPEN)
            revert OTCErrors.OrderNotOpen();
        if (msg.sender != o.seller) revert OTCErrors.NotSeller();

        o.status = OTCEnums.OrderStatus.CANCELLED;
        emit OrderCancelled(orderId);
    }

    // Buyer accepts: deposit stable + fee to escrow, create trade
    function takeOrder(uint256 orderId) external returns (uint256 tradeId) {
        IAdminLike(admin).assertActiveUser(msg.sender);

        OTCStructs.Order storage o = orders[orderId];
        if (o.status != OTCEnums.OrderStatus.OPEN)
            revert OTCErrors.OrderNotOpen();
        if (o.seller == address(0)) revert OTCErrors.InvalidAmount();
        if (msg.sender == o.seller) revert OTCErrors.InvalidAmount();
        if (o.takenTradeId != 0) revert OTCErrors.OrderAlreadyTaken();
        if (escrow == address(0)) revert("escrow not set");

        uint256 feeAmount = o.quoteAmount.bpsMul(IConfigLike(config).feeBps());
        uint256 total = o.quoteAmount + feeAmount;

        // pull stable from buyer to escrow
        bool ok = IERC20Like(o.quoteToken).transferFrom(
            msg.sender,
            escrow,
            total
        );
        if (!ok) revert OTCErrors.TransferFailed();

        tradeId = IOTCEscrow(escrow).openTradeFromOrder(
            o.id,
            msg.sender,
            o.seller,
            o.quoteToken,
            o.quoteAmount,
            feeAmount
        );

        o.status = OTCEnums.OrderStatus.TAKEN;
        o.takenTradeId = tradeId;

        emit OrderTaken(orderId, tradeId, msg.sender);
    }

    // -------------------------
    // Pricing (Phase 1)
    // -------------------------

    // QuoteAmount is stable token amount with 6 decimals usually,
    // but we don't assume token decimals on-chain to keep MVP simple.
    // Frontend should pass sellAmount in 1e18 units, and we output quoteAmount in 1e18 too,
    // OR you can standardize to 1e6 offchain. For strictness, do the decimal normalization in backend/frontend.
    //
    // For MVP: quoteAmount = sellAmount * oraclePrice / 10^feedDecimals, then apply spreadBps.
    function _calcQuoteAmount(
        bytes32 sellAsset,
        uint256 sellAmount
    ) internal view returns (uint256) {
        (uint256 p, uint8 d) = IConfigLike(config).getOraclePrice(sellAsset);

        // Base: sellAmount(1e18) * price(10^d) / 10^d = 1e18-scaled "USD"
        uint256 base = (sellAmount * p) / (10 ** uint256(d));

        // Placeholder for future: weightedAveragePrice(base) (currently 1:1)
        uint256 weighted = _weightedAveragePrice(base);

        // Apply spread
        uint256 withSpread = weighted.bpsAdd(IConfigLike(config).spreadBps());
        return withSpread;
    }

    function _weightedAveragePrice(
        uint256 oraclePrice
    ) internal pure returns (uint256) {
        return oraclePrice; // Phase 1: 1:1
    }
}
