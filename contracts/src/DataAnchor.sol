// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract DataAnchor is AccessControl {
    bytes32 public constant WRITER_ROLE = keccak256("WRITER_ROLE");

    // Kunci anchoring: (recordId, version) harus unik (FR-5.3)
    mapping(bytes32 => bool) public anchored;

    // Akar log audit per posisi terakhir batch (FR-7.4): to_seq -> root.
    // Re-anchor dengan to_seq yang sama hanya diterima bila akarnya SAMA
    // (idempoten); akar berbeda untuk to_seq yang sama berarti log sudah
    // berubah -> ditolak.
    mapping(uint256 => bytes32) public auditRootAt;

    event DataAnchored(
        string indexed recordId,
        uint256 indexed version,
        bytes32 indexed commitment,
        bytes32 categoryHash,
        address writer,
        uint256 blockNumber
    );

    event RecordSuperseded(
        string indexed oldRecordId,
        uint256 indexed oldVersion,
        string indexed newRecordId,
        uint256 newVersion,
        bytes32 newCommitment,
        bytes32 newCategoryHash,
        address writer,
        uint256 blockNumber
    );

    // Akar pohon Merkle log audit di-anchor berkala (FR-7.4). `to_seq` adalah
    // posisi 1-based entri log terakhir dalam batch, `root` akar pohon atas
    // batch itu, `headHash` entry_hash entri terakhir (penjaga pemotongan ekor).
    event AuditRootAnchored(
        uint256 indexed toSeq, bytes32 indexed root, bytes32 headHash, address writer, uint256 blockNumber
    );

    constructor(
        address admin
    ) {
        if (admin == address(0)) {
            admin = msg.sender;
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(WRITER_ROLE, admin);
    }

    function _key(
        string memory recordId,
        uint256 version
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(recordId, version));
    }

    function isAnchored(
        string memory recordId,
        uint256 version
    ) external view returns (bool) {
        return anchored[_key(recordId, version)];
    }

    function anchor(
        string memory recordId,
        uint256 version,
        bytes32 commitment,
        bytes32 categoryHash
    ) external onlyRole(WRITER_ROLE) {
        bytes32 k = _key(recordId, version);
        require(!anchored[k], "DataAnchor: already anchored");
        anchored[k] = true;
        emit DataAnchored(recordId, version, commitment, categoryHash, msg.sender, block.number);
    }

    function supersede(
        string memory oldRecordId,
        uint256 oldVersion,
        string memory newRecordId,
        uint256 newVersion,
        bytes32 newCommitment,
        bytes32 newCategoryHash
    ) external onlyRole(WRITER_ROLE) {
        // Pastikan record lama memang sudah di-anchor (defensif, bukan wajib FR)
        bytes32 kOld = _key(oldRecordId, oldVersion);
        require(anchored[kOld], "DataAnchor: old record not anchored");

        bytes32 kNew = _key(newRecordId, newVersion);
        require(!anchored[kNew], "DataAnchor: new record already anchored");

        anchored[kNew] = true;
        emit RecordSuperseded(
            oldRecordId, oldVersion, newRecordId, newVersion, newCommitment, newCategoryHash, msg.sender, block.number
        );
    }

    // Catat akar log audit (FR-7.4). Idempoten per `toSeq`: mengulang dengan
    // akar yang sama boleh (mis. retry setelah tx ragu), tetapi akar berbeda
    // untuk `toSeq` yang sama ditolak -- itu tanda log sudah dimodifikasi.
    function anchorAuditRoot(
        uint256 toSeq,
        bytes32 root,
        bytes32 headHash
    ) external onlyRole(WRITER_ROLE) {
        require(toSeq > 0, "DataAnchor: toSeq must be positive");
        require(root != bytes32(0), "DataAnchor: root must not be zero");
        bytes32 prev = auditRootAt[toSeq];
        require(prev == bytes32(0) || prev == root, "DataAnchor: audit root mismatch for toSeq");
        auditRootAt[toSeq] = root;
        emit AuditRootAnchored(toSeq, root, headHash, msg.sender, block.number);
    }

    function isAuditRootAnchored(
        uint256 toSeq,
        bytes32 root
    ) external view returns (bool) {
        return root != bytes32(0) && auditRootAt[toSeq] == root;
    }
}
