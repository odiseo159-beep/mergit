// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../contracts/MergitEscrow.sol";

/**
 * @title MergitReentrancyAttacker
 * @notice Contrato atacante para probar la protección contra reentrancy (nonReentrant)
 *         en las funciones settle y refund de MergitEscrow.
 */
contract MergitReentrancyAttacker {
    MergitEscrow public escrow;
    bool public attackOnSettle = false;
    bool public attackOnRefund = false;
    uint256 public targetBountyId;
    bool public attemptedReentrancy = false;

    constructor(address payable _escrowAddress) {
        escrow = MergitEscrow(_escrowAddress);
    }

    receive() external payable {
        if (msg.sender == address(escrow)) {
            if (attackOnSettle && !attemptedReentrancy) {
                attemptedReentrancy = true;
                try escrow.settle(targetBountyId, address(this), keccak256("ataque")) {
                } catch {
                }
            } else if (attackOnRefund && !attemptedReentrancy) {
                attemptedReentrancy = true;
                try escrow.refund(targetBountyId) {
                } catch {
                }
            }
        }
    }

    function triggerAttackSettle(uint256 _bountyId) external {
        targetBountyId = _bountyId;
        attackOnSettle = true;
        attemptedReentrancy = false;
        escrow.settle(_bountyId, address(this), keccak256("prueba"));
        attackOnSettle = false;
    }

    function triggerAttackRefund(uint256 _bountyId) external {
        targetBountyId = _bountyId;
        attackOnRefund = true;
        attemptedReentrancy = false;
        escrow.refund(_bountyId);
        attackOnRefund = false;
    }
}
