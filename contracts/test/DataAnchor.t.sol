// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {DataAnchor} from "../src/DataAnchor.sol";

contract DataAnchorTest is Test {
    DataAnchor public da;
    address public admin = address(0xA11CE);
    address public writer = address(0xB0B);
    address public stranger = address(0xCAFE);

    function setUp() public {
        vm.prank(admin);
        da = new DataAnchor(admin);
        bytes32 writerRole = da.WRITER_ROLE();
        vm.prank(admin);
        da.grantRole(writerRole, writer);
    }

    function testAnchorNormal() public {
        string memory rid = "rec-001";
        uint256 ver = 1;
        bytes32 com = keccak256("commitment");
        bytes32 cat = keccak256("Catin");

        vm.prank(writer);
        vm.expectEmit(true, true, true, false);
        emit DataAnchor.DataAnchored(rid, ver, com, cat, writer, block.number + 1);
        da.anchor(rid, ver, com, cat);

        assertTrue(da.isAnchored(rid, ver));
    }

    function testAnchorDuplicate() public {
        string memory rid = "rec-002";
        uint256 ver = 1;
        bytes32 com = keccak256("c");
        bytes32 cat = keccak256("x");

        vm.prank(writer);
        da.anchor(rid, ver, com, cat);
        vm.prank(writer);
        vm.expectRevert(bytes("DataAnchor: already anchored"));
        da.anchor(rid, ver, com, cat);
    }

    function testAnchorWithoutRole() public {
        string memory rid = "rec-003";
        uint256 ver = 1;
        bytes32 com = keccak256("c");
        bytes32 cat = keccak256("x");

        bytes32 wr = da.WRITER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, wr));
        da.anchor(rid, ver, com, cat);
    }

    function testSupersedeNormal() public {
        string memory oldRid = "rec-004-old";
        uint256 oldVer = 1;
        string memory newRid = "rec-004-new";
        uint256 newVer = 2;
        bytes32 com = keccak256("c-new");
        bytes32 cat = keccak256("Catin");

        vm.prank(writer);
        da.anchor(oldRid, oldVer, keccak256("c-old"), cat);

        vm.prank(writer);
        vm.expectEmit(true, true, true, false);
        emit DataAnchor.RecordSuperseded(oldRid, oldVer, newRid, newVer, com, cat, writer, block.number + 1);
        da.supersede(oldRid, oldVer, newRid, newVer, com, cat);

        assertTrue(da.isAnchored(newRid, newVer));
        assertTrue(da.isAnchored(oldRid, oldVer));
    }

    function testSupersedeDuplicateNew() public {
        string memory oldRid = "rec-005-old";
        uint256 oldVer = 1;
        string memory newRid = "rec-005-new";
        uint256 newVer = 2;
        bytes32 com = keccak256("c");
        bytes32 cat = keccak256("x");

        vm.prank(writer);
        da.anchor(oldRid, oldVer, keccak256("c-old"), cat);
        vm.prank(writer);
        da.anchor(newRid, newVer, com, cat);

        vm.prank(writer);
        vm.expectRevert(bytes("DataAnchor: new record already anchored"));
        da.supersede(oldRid, oldVer, newRid, newVer, com, cat);
    }

    // --- Akar log audit (FR-7.4) -------------------------------------------

    function testAnchorAuditRootNormal() public {
        uint256 toSeq = 5;
        bytes32 root = keccak256("audit-root-v1");
        bytes32 head = keccak256("audit-head-v1");

        assertFalse(da.isAuditRootAnchored(toSeq, root));

        vm.prank(writer);
        vm.expectEmit(true, true, false, false);
        emit DataAnchor.AuditRootAnchored(toSeq, root, head, writer, block.number + 1);
        da.anchorAuditRoot(toSeq, root, head);

        assertTrue(da.isAuditRootAnchored(toSeq, root));
        assertEq(da.auditRootAt(toSeq), root);
    }

    function testIsAuditRootAnchoredFalseForDifferentRoot() public {
        uint256 toSeq = 6;
        bytes32 root = keccak256("audit-root-a");

        vm.prank(writer);
        da.anchorAuditRoot(toSeq, root, bytes32(0));

        assertTrue(da.isAuditRootAnchored(toSeq, root));
        assertFalse(da.isAuditRootAnchored(toSeq, keccak256("audit-root-b")));
        assertFalse(da.isAuditRootAnchored(999, root));
    }

    function testAnchorAuditRootIdempotent() public {
        uint256 toSeq = 7;
        bytes32 root = keccak256("audit-root-v1");
        bytes32 head = keccak256("audit-head-v1");

        vm.prank(writer);
        da.anchorAuditRoot(toSeq, root, head);
        // Re-anchor toSeq yang sama dengan akar yang sama boleh (retry).
        vm.prank(writer);
        da.anchorAuditRoot(toSeq, root, head);
        assertEq(da.auditRootAt(toSeq), root);
    }

    function testAnchorAuditRootMismatchReverts() public {
        uint256 toSeq = 8;
        vm.prank(writer);
        da.anchorAuditRoot(toSeq, keccak256("audit-root-a"), bytes32(0));

        vm.prank(writer);
        vm.expectRevert(bytes("DataAnchor: audit root mismatch for toSeq"));
        da.anchorAuditRoot(toSeq, keccak256("audit-root-b"), bytes32(0));
    }

    function testAnchorAuditRootRejectsZero() public {
        vm.prank(writer);
        vm.expectRevert(bytes("DataAnchor: toSeq must be positive"));
        da.anchorAuditRoot(0, keccak256("root"), bytes32(0));

        vm.prank(writer);
        vm.expectRevert(bytes("DataAnchor: root must not be zero"));
        da.anchorAuditRoot(1, bytes32(0), bytes32(0));
    }

    function testAnchorAuditRootWithoutRole() public {
        bytes32 wr = da.WRITER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, wr));
        da.anchorAuditRoot(1, keccak256("root"), bytes32(0));
    }
}
