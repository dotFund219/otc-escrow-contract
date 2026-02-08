// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockV3Aggregator {
    uint8 public decimals;
    int256 private answer;

    constructor(uint8 _decimals, int256 _initialAnswer) {
        decimals = _decimals;
        answer = _initialAnswer;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (0, answer, block.timestamp, block.timestamp, 0);
    }

    function updateAnswer(int256 newAnswer) external {
        answer = newAnswer;
    }
}
