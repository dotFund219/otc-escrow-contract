// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IChainlinkAggregatorV3.sol";
import "../libraries/OTCStructs.sol";
import "../libraries/OTCErrors.sol";

contract OTCConfig {
    address public owner;
    address public treasury;

    // fee in bps (e.g., 30 = 0.30%)
    uint256 public feeBps;

    // spread in bps added on top of oracle price for quote calculation
    uint256 public spreadBps;

    mapping(address => OTCStructs.AssetConfig) public assets; // "WBTC","WETH", "USDT", "USDC" only in phase 1
    mapping(address => bool) public allowedQuoteTokens; // "WBTC", "WETH", "USDT", "USDC" only in phase 1

    event TreasurySet(address indexed treasury);
    event FeeSet(uint256 feeBps);
    event SpreadSet(uint256 spreadBps);
    event AssetSet(address indexed token, address feed, bool enabled);
    event QuoteTokenSet(address indexed token, bool allowed);

    constructor(address _owner, address _treasury) {
        owner = _owner;
        treasury = _treasury;
        feeBps = 0;
        spreadBps = 0;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OTCErrors.NotOwner();
        _;
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "zero");
        treasury = _treasury;
        emit TreasurySet(_treasury);
    }

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 500, "fee too high"); // guardrail
        feeBps = _feeBps;
        emit FeeSet(_feeBps);
    }

    function setSpreadBps(uint256 _spreadBps) external onlyOwner {
        require(_spreadBps <= 2_000, "spread too high"); // guardrail
        spreadBps = _spreadBps;
        emit SpreadSet(_spreadBps);
    }

    function setQuoteToken(address token, bool allowed) external onlyOwner {
        allowedQuoteTokens[token] = allowed;
        emit QuoteTokenSet(token, allowed);
    }

    function setAsset(
        address token,
        address feed,
        bool enabled
    ) external onlyOwner {
        require(feed != address(0), "zero feed");
        uint8 dec = IChainlinkAggregatorV3(feed).decimals();
        assets[token] = OTCStructs.AssetConfig({
            enabled: enabled,
            chainlinkFeed: feed,
            feedDecimals: dec
        });
        emit AssetSet(token, feed, enabled);
    }

    function getOraclePrice(
        address token
    ) external view returns (uint256 price, uint8 decimals_) {
        OTCStructs.AssetConfig memory cfg = assets[token];
        if (!cfg.enabled) revert OTCErrors.UnsupportedAsset();

        (, int256 answer, , uint256 updatedAt, ) = IChainlinkAggregatorV3(
            cfg.chainlinkFeed
        ).latestRoundData();
        require(updatedAt > 0, "stale");
        require(answer > 0, "bad");

        return (uint256(answer), cfg.feedDecimals);
    }
}
