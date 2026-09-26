// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

// Small on purpose: this bytecode is committed as a test fixture, so every byte is
// something a later reader has to trust. It exercises the two revert shapes a
// simulation must tell apart — a custom error whose 4-byte selector is a protocol fact
// (`ERC20InsufficientBalance(address,uint256,uint256)` = 0xe450d38c, the OZ 5.x selector
// @ari/simulation's table carries) and a `require` string, whose text belongs to whoever
// wrote the contract and is therefore never classified by content.
contract MiniERC20 {
    // Named exactly as OpenZeppelin 5.x names it, because the 4-byte selector is what
// @ari/simulation's table keys on and a rename here would silently become
// `REVERT_CUSTOM_UNKNOWN` in the test below.
error ERC20InsufficientBalance(address account, uint256 has, uint256 wants);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 initial) {
        balanceOf[msg.sender] = initial;
    }

    function mintTo(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(to != address(0), "MiniERC20: zero destination");
        uint256 has = balanceOf[msg.sender];
        if (has < amount) revert ERC20InsufficientBalance(msg.sender, has, amount);
        balanceOf[msg.sender] = has - amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}
