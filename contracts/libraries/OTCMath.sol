// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library OTCMath {
    function bpsAdd(
        uint256 value,
        uint256 bps
    ) internal pure returns (uint256) {
        return value + (value * bps) / 10_000;
    }

    function bpsMul(
        uint256 value,
        uint256 bps
    ) internal pure returns (uint256) {
        return (value * bps) / 10_000;
    }
}
