// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library OTCErrors {
    error NotOwner();
    error NotAdmin();
    error NotSeller();
    error NotBuyer();
    error UserFrozenOrBanned();

    error UnsupportedAsset();
    error InvalidToken();
    error InvalidAmount();
    error InvalidState();
    error OrderNotOpen();
    error OrderAlreadyTaken();
    error TransferFailed();
}
