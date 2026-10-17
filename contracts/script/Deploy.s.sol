// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {DataAnchor} from "../src/DataAnchor.sol";

contract Deploy is Script {
    function run() external returns (DataAnchor) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address admin = vm.envOr("ADMIN_ADDRESS", deployer);
        address writer = vm.envOr("WRITER_ADDRESS", deployer);

        vm.startBroadcast(deployerPrivateKey);
        DataAnchor da = new DataAnchor(admin);
        if (writer != admin) {
            da.grantRole(da.WRITER_ROLE(), writer);
        }
        vm.stopBroadcast();

        return da;
    }
}
