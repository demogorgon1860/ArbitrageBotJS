// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title Arb - Arbitrage Helper Contract
 * @dev Utility contract for arbitrage monitoring and analysis
 * @notice This contract is for monitoring only - does not execute trades
 */
contract Arb is Ownable, ReentrancyGuard, Pausable {
    
    struct TokenInfo {
        address tokenAddress;
        string symbol;
        uint8 decimals;
        uint256 balance;
        uint256 totalSupply;
    }
    
    struct PriceInfo {
        address tokenA;
        address tokenB;
        uint256 reserveA;
        uint256 reserveB;
        uint256 price;
        uint256 timestamp;
    }
    
    // Events
    event BalanceChecked(address indexed token, uint256 balance, uint256 timestamp);
    event PriceChecked(address indexed tokenA, address indexed tokenB, uint256 price, uint256 timestamp);
    event EmergencyWithdraw(address indexed token, uint256 amount, address to);
    
    // Errors
    error InvalidAddress();
    error InsufficientBalance();
    error TransferFailed();
    error ContractPaused();
    
    constructor() {
        // Contract is initially unpaused
    }
    
    /**
     * @dev Pause contract operations (emergency only)
     */
    function pause() external onlyOwner {
        _pause();
    }
    
    /**
     * @dev Unpause contract operations
     */
    function unpause() external onlyOwner {
        _unpause();
    }
    
    /**
     * @dev Get balance of a specific token for this contract
     * @param tokenAddress Address of the ERC20 token (use address(0) for native MATIC)
     * @return balance Token balance in wei
     */
    function getBalance(address tokenAddress) external view returns (uint256 balance) {
        if (tokenAddress == address(0)) {
            return address(this).balance;
        } else {
            return IERC20(tokenAddress).balanceOf(address(this));
        }
    }
    
    /**
     * @dev Get balances of multiple tokens efficiently
     * @param tokenAddresses Array of token addresses to check
     * @return balances Array of token balances
     */
    function getMultipleBalances(address[] calldata tokenAddresses) 
        external 
        view 
        returns (uint256[] memory balances) 
    {
        uint256 length = tokenAddresses.length;
        balances = new uint256[](length);
        
        for (uint256 i = 0; i < length; i++) {
            if (tokenAddresses[i] == address(0)) {
                balances[i] = address(this).balance;
            } else {
                balances[i] = IERC20(tokenAddresses[i]).balanceOf(address(this));
            }
        }
        
        return balances;
    }
    
    /**
     * @dev Get comprehensive token information
     * @param tokenAddress Address of the ERC20 token
     * @return tokenInfo Struct containing all token details
     */
    function getTokenInfo(address tokenAddress) 
        external 
        view 
        returns (TokenInfo memory tokenInfo) 
    {
        if (tokenAddress == address(0)) {
            return TokenInfo({
                tokenAddress: address(0),
                symbol: "MATIC",
                decimals: 18,
                balance: address(this).balance,
                totalSupply: 0
            });
        }
        
        IERC20 token = IERC20(tokenAddress);
        IERC20Metadata tokenMeta = IERC20Metadata(tokenAddress);
        
        // Get token info with fallback values
        string memory symbol;
        uint8 decimals;
        uint256 totalSupply;
        
        try tokenMeta.symbol() returns (string memory _symbol) {
            symbol = _symbol;
        } catch {
            symbol = "UNKNOWN";
        }
        
        try tokenMeta.decimals() returns (uint8 _decimals) {
            decimals = _decimals;
        } catch {
            decimals = 18;
        }
        
        try token.totalSupply() returns (uint256 _totalSupply) {
            totalSupply = _totalSupply;
        } catch {
            totalSupply = 0;
        }
        
        return TokenInfo({
            tokenAddress: tokenAddress,
            symbol: symbol,
            decimals: decimals,
            balance: token.balanceOf(address(this)),
            totalSupply: totalSupply
        });
    }
    
    /**
     * @dev Get multiple token information efficiently
     * @param tokenAddresses Array of token addresses
     * @return tokenInfos Array of token information structs
     */
    function getMultipleTokenInfo(address[] calldata tokenAddresses)
        external
        view
        returns (TokenInfo[] memory tokenInfos)
    {
        uint256 length = tokenAddresses.length;
        tokenInfos = new TokenInfo[](length);
        
        for (uint256 i = 0; i < length; i++) {
            tokenInfos[i] = this.getTokenInfo(tokenAddresses[i]);
        }
        
        return tokenInfos;
    }
    
    /**
     * @dev Check if token contract is valid
     * @param tokenAddress Address to check
     * @return isValid True if valid ERC20 contract
     */
    function isValidToken(address tokenAddress) external view returns (bool isValid) {
        if (tokenAddress == address(0)) {
            return true; // Native MATIC is valid
        }
        
        // Check if contract exists
        uint256 size;
        assembly {
            size := extcodesize(tokenAddress)
        }
        
        if (size == 0) {
            return false;
        }
        
        // Try to call basic ERC20 functions
        try IERC20(tokenAddress).totalSupply() returns (uint256) {
            try IERC20Metadata(tokenAddress).decimals() returns (uint8) {
                return true;
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }
    
    /**
     * @dev Batch check token validity
     * @param tokenAddresses Array of addresses to check
     * @return validTokens Array of boolean values
     */
    function batchValidateTokens(address[] calldata tokenAddresses)
        external
        view
        returns (bool[] memory validTokens)
    {
        uint256 length = tokenAddresses.length;
        validTokens = new bool[](length);
        
        for (uint256 i = 0; i < length; i++) {
            validTokens[i] = this.isValidToken(tokenAddresses[i]);
        }
        
        return validTokens;
    }
    
    /**
     * @dev Get contract version and info
     * @return version Contract version
     * @return deployed Deployment timestamp
     * @return paused Whether contract is paused
     */
    function getContractInfo() 
        external 
        view 
        returns (string memory version, uint256 deployed, bool paused) 
    {
        return ("1.0.0", block.timestamp, paused());
    }
    
    /**
     * @dev Emergency function to withdraw tokens (owner only)
     * @param tokenAddress Token to withdraw (address(0) for MATIC)
     * @param amount Amount to withdraw
     * @param to Address to send tokens to
     */
    function emergencyWithdraw(address tokenAddress, uint256 amount, address to) 
        external 
        onlyOwner 
        nonReentrant 
        whenNotPaused
    {
        if (to == address(0)) revert InvalidAddress();
        
        if (tokenAddress == address(0)) {
            // Withdraw MATIC
            if (address(this).balance < amount) revert InsufficientBalance();
            
            (bool success, ) = to.call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            // Withdraw ERC20 token
            IERC20 token = IERC20(tokenAddress);
            if (token.balanceOf(address(this)) < amount) revert InsufficientBalance();
            
            bool success = token.transfer(to, amount);
            if (!success) revert TransferFailed();
        }
        
        emit EmergencyWithdraw(tokenAddress, amount, to);
    }
    
    /**
     * @dev Emergency function to withdraw all tokens (owner only)
     * @param tokenAddresses Array of token addresses to withdraw
     * @param to Address to send tokens to
     */
    function emergencyWithdrawAll(address[] calldata tokenAddresses, address to)
        external
        onlyOwner
        nonReentrant
        whenNotPaused
    {
        if (to == address(0)) revert InvalidAddress();
        
        // Withdraw all specified tokens
        for (uint256 i = 0; i < tokenAddresses.length; i++) {
            address tokenAddress = tokenAddresses[i];
            uint256 balance;
            
            if (tokenAddress == address(0)) {
                balance = address(this).balance;
                if (balance > 0) {
                    (bool success, ) = to.call{value: balance}("");
                    if (!success) revert TransferFailed();
                }
            } else {
                IERC20 token = IERC20(tokenAddress);
                balance = token.balanceOf(address(this));
                if (balance > 0) {
                    bool success = token.transfer(to, balance);
                    if (!success) revert TransferFailed();
                }
            }
            
            if (balance > 0) {
                emit EmergencyWithdraw(tokenAddress, balance, to);
            }
        }
    }
    
    /**
     * @dev Allow contract to receive MATIC
     */
    receive() external payable {
        // Contract can receive MATIC
    }
    
    /**
     * @dev Fallback function
     */
    fallback() external payable {
        // Fallback to receive function
    }
}