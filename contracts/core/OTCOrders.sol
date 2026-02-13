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

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

interface IAdminLike {
    function assertActiveUser(address user) external view;
}

interface IConfigLike {
    function allowedQuoteTokens(address token) external view returns (bool);
    function feeBps() external view returns (uint256);
    function spreadBps() external view returns (uint256);
    function getOraclePrice(
        address token
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
        address sellToken,
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

    // ------------------------------------------------------------
    // Order lifecycle
    // ------------------------------------------------------------

    function createOrder(
        address sellToken, // "WBTC" or "WETH" or "USDT" or "USDC"
        uint256 sellAmount, // 1e18 units
        address quoteToken // USDT / USDC (6 decimals)
    ) external returns (uint256 orderId) {
        IAdminLike(admin).assertActiveUser(msg.sender);

        if (sellAmount == 0) revert OTCErrors.InvalidAmount();
        if (!IConfigLike(config).allowedQuoteTokens(quoteToken))
            revert OTCErrors.InvalidToken();

        if (!IConfigLike(config).allowedQuoteTokens(sellToken))
            revert OTCErrors.InvalidToken();

        require(sellToken != quoteToken, "buy=sell");

        uint256 quoteAmount = _calcQuoteAmount(
            sellToken,
            sellAmount,
            quoteToken
        );

        orderId = nextOrderId++;

        orders[orderId] = OTCStructs.Order({
            id: orderId,
            seller: msg.sender,
            sellAsset: sellToken,
            sellAmount: sellAmount,
            quoteToken: quoteToken,
            quoteAmount: quoteAmount, // ✅ token decimals (6)
            createdAt: block.timestamp,
            status: OTCEnums.OrderStatus.OPEN,
            takenTradeId: 0
        });

        emit OrderCreated(
            orderId,
            msg.sender,
            sellToken,
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

    function takeOrder(uint256 orderId) external returns (uint256 tradeId) {
        IAdminLike(admin).assertActiveUser(msg.sender);

        OTCStructs.Order storage o = orders[orderId];
        if (o.status != OTCEnums.OrderStatus.OPEN)
            revert OTCErrors.OrderNotOpen();
        if (msg.sender == o.seller) revert OTCErrors.InvalidAmount();
        if (o.takenTradeId != 0) revert OTCErrors.OrderAlreadyTaken();
        if (escrow == address(0)) revert("escrow not set");

        uint256 feeAmount = o.quoteAmount.bpsMul(IConfigLike(config).feeBps());
        uint256 total = o.quoteAmount + feeAmount;

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
            o.sellAsset,
            o.sellAmount,
            o.quoteToken,
            o.quoteAmount,
            feeAmount
        );

        o.status = OTCEnums.OrderStatus.TAKEN;
        o.takenTradeId = tradeId;

        emit OrderTaken(orderId, tradeId, msg.sender);
    }

    // ------------------------------------------------------------
    // Pricing (correct decimals handling)
    // ------------------------------------------------------------

    /**
     * sellAmount: 1e18
     * oracle price: price * 10^feedDecimals (feedDecimals=8)
     *
     * Steps:
     * 1) USD value in 1e18
     * 2) Apply spread (bps)
     * 3) Convert 1e18 USD value -> quoteToken decimals (USDT=6)
     */
    function _calcQuoteAmount(
        address sellToken,
        uint256 sellAmount,
        address quoteToken
    ) internal view returns (uint256) {
        (uint256 sellPrice, uint8 sellFeedDec) = IConfigLike(config)
            .getOraclePrice(sellToken);
        (uint256 quotePrice, uint8 quoteFeedDec) = IConfigLike(config)
            .getOraclePrice(quoteToken);

        uint8 sellDec = IERC20Decimals(sellToken).decimals();
        uint8 quoteDec = IERC20Decimals(quoteToken).decimals();

        uint256 sellAmount18 = _to18(sellAmount, sellDec);

        uint256 usdValue18 = (sellAmount18 * sellPrice) /
            (10 ** uint256(sellFeedDec));

        uint256 usdWithSpread = usdValue18.bpsAdd(
            IConfigLike(config).spreadBps()
        );

        uint256 quoteAmount18 = (usdWithSpread *
            (10 ** uint256(quoteFeedDec))) / quotePrice;

        return _from18(quoteAmount18, quoteDec);
    }

    function _to18(
        uint256 amount,
        uint8 decimals
    ) internal pure returns (uint256) {
        if (decimals == 18) {
            return amount;
        } else if (decimals < 18) {
            return amount * (10 ** (18 - decimals));
        } else {
            return amount / (10 ** (decimals - 18));
        }
    }

    function _from18(
        uint256 amount,
        uint8 decimals
    ) internal pure returns (uint256) {
        if (decimals == 18) {
            return amount;
        } else if (decimals < 18) {
            return amount / (10 ** (18 - decimals));
        } else {
            return amount * (10 ** (decimals - 18));
        }
    }
}
