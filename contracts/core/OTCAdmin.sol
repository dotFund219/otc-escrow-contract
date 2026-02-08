// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/OTCErrors.sol";

contract OTCAdmin {
    address public owner;

    mapping(address => bool) public isAdmin;
    mapping(address => bool) public banned;
    mapping(address => bool) public frozen;

    // KYC tier-2 flag (manual admin approval)
    mapping(address => bool) public tier2Approved;

    event OwnershipTransferred(
        address indexed oldOwner,
        address indexed newOwner
    );
    event AdminSet(address indexed admin, bool enabled);
    event UserBanned(address indexed user, bool banned);
    event UserFrozen(address indexed user, bool frozen);
    event Tier2Set(address indexed user, bool approved);

    constructor(address _owner) {
        owner = _owner;
        isAdmin[_owner] = true;
        emit AdminSet(_owner, true);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OTCErrors.NotOwner();
        _;
    }

    modifier onlyAdmin() {
        if (!isAdmin[msg.sender]) revert OTCErrors.NotAdmin();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero");
        address old = owner;
        owner = newOwner;
        isAdmin[newOwner] = true;
        emit OwnershipTransferred(old, newOwner);
        emit AdminSet(newOwner, true);
    }

    function setAdmin(address admin, bool enabled) external onlyOwner {
        isAdmin[admin] = enabled;
        emit AdminSet(admin, enabled);
    }

    function setBanned(address user, bool _banned) external onlyAdmin {
        banned[user] = _banned;
        emit UserBanned(user, _banned);
    }

    function setFrozen(address user, bool _frozen) external onlyAdmin {
        frozen[user] = _frozen;
        emit UserFrozen(user, _frozen);
    }

    function setTier2(address user, bool approved) external onlyAdmin {
        tier2Approved[user] = approved;
        emit Tier2Set(user, approved);
    }

    function assertActiveUser(address user) external view {
        if (banned[user] || frozen[user]) revert OTCErrors.UserFrozenOrBanned();
    }
}
