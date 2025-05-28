const { ethers } = require("hardhat");
const config = require('../config/polygon.json');

class ContractInteraction {
    constructor() {
        this.arbContract = null;
        this.provider = null;
    }
    
    async init() {
        // Get provider and contract
        this.provider = ethers.provider;
        
        // Check if contract is deployed
        if (!config.contracts || !config.contracts.arb) {
            throw new Error("Arb contract not deployed. Run: npx hardhat run scripts/deploy.js --network polygon");
        }
        
        const contractAddress = config.contracts.arb.address;
        console.log("📋 Using Arb contract at:", contractAddress);
        
        // Get contract instance
        const Arb = await ethers.getContractFactory("Arb");
        this.arbContract = Arb.attach(contractAddress);
        
        console.log("✅ Contract connection established");
    }
    
    /**
     * Check token balances using the contract
     */
    async checkTokenBalances() {
        console.log("\n🔍 Checking token balances...");
        
        const tokenAddresses = Object.values(config.tokens).map(token => token.address);
        
        try {
            // Get multiple balances efficiently
            const balances = await this.arbContract.getMultipleBalances(tokenAddresses);
            
            console.log("📊 Token Balances:");
            Object.entries(config.tokens).forEach(([symbol, token], index) => {
                const balance = ethers.utils.formatUnits(balances[index], token.decimals);
                console.log(`   ${symbol}: ${balance}`);
            });
            
            // Check MATIC balance
            const maticBalance = await this.arbContract.getBalance(ethers.constants.AddressZero);
            console.log(`   MATIC: ${ethers.utils.formatEther(maticBalance)}`);
            
        } catch (error) {
            console.error("❌ Failed to check balances:", error.message);
        }
    }
    
    /**
     * Get detailed token information
     */
    async getTokenInfo() {
        console.log("\n📋 Getting detailed token information...");
        
        const tokenAddresses = Object.values(config.tokens).map(token => token.address);
        
        try {
            const tokenInfos = await this.arbContract.getMultipleTokenInfo(tokenAddresses);
            
            console.log("📊 Detailed Token Info:");
            tokenInfos.forEach((info, index) => {
                const symbol = Object.keys(config.tokens)[index];
                console.log(`   ${symbol}:`);
                console.log(`     Address: ${info.tokenAddress}`);
                console.log(`     Symbol: ${info.symbol}`);
                console.log(`     Decimals: ${info.decimals}`);
                console.log(`     Balance: ${ethers.utils.formatUnits(info.balance, info.decimals)}`);
                console.log(`     Total Supply: ${ethers.utils.formatUnits(info.totalSupply, info.decimals)}`);
            });
            
        } catch (error) {
            console.error("❌ Failed to get token info:", error.message);
        }
    }
    
    /**
     * Validate all token contracts
     */
    async validateTokens() {
        console.log("\n✅ Validating token contracts...");
        
        const tokenAddresses = Object.values(config.tokens).map(token => token.address);
        
        try {
            const validTokens = await this.arbContract.batchValidateTokens(tokenAddresses);
            
            console.log("🔍 Token Validation Results:");
            Object.entries(config.tokens).forEach(([symbol, token], index) => {
                const isValid = validTokens[index];
                const status = isValid ? "✅ Valid" : "❌ Invalid";
                console.log(`   ${symbol} (${token.address}): ${status}`);
            });
            
        } catch (error) {
            console.error("❌ Failed to validate tokens:", error.message);
        }
    }
    
    /**
     * Get contract information
     */
    async getContractInfo() {
        console.log("\n📋 Getting contract information...");
        
        try {
            const contractInfo = await this.arbContract.getContractInfo();
            const owner = await this.arbContract.owner();
            
            console.log("📊 Contract Information:");
            console.log(`   Version: ${contractInfo.version}`);
            console.log(`   Deployed: ${new Date(contractInfo.deployed * 1000).toISOString()}`);
            console.log(`   Paused: ${contractInfo.paused}`);
            console.log(`   Owner: ${owner}`);
            console.log(`   Address: ${this.arbContract.address}`);
            
        } catch (error) {
            console.error("❌ Failed to get contract info:", error.message);
        }
    }
    
    /**
     * Test contract functionality
     */
    async testContract() {
        console.log("\n🧪 Testing contract functionality...");
        
        try {
            // Test basic balance check
            const usdcAddress = config.tokens.USDC.address;
            const usdcBalance = await this.arbContract.getBalance(usdcAddress);
            console.log(`✅ Balance check test passed - USDC: ${ethers.utils.formatUnits(usdcBalance, 6)}`);
            
            // Test token validation
            const isValidUSDC = await this.arbContract.isValidToken(usdcAddress);
            console.log(`✅ Token validation test passed - USDC valid: ${isValidUSDC}`);
            
            // Test invalid token
            const isValidInvalid = await this.arbContract.isValidToken("0x0000000000000000000000000000000000000001");
            console.log(`✅ Invalid token test passed - Should be false: ${isValidInvalid}`);
            
            console.log("🎉 All contract tests passed!");
            
        } catch (error) {
            console.error("❌ Contract test failed:", error.message);
        }
    }
}

async function main() {
    console.log("🔧 Arb Contract Interaction Tool");
    console.log("=".repeat(40));
    
    const interaction = new ContractInteraction();
    
    try {
        await interaction.init();
        
        // Run all tests
        await interaction.getContractInfo();
        await interaction.validateTokens();
        await interaction.getTokenInfo();
        await interaction.checkTokenBalances();
        await interaction.testContract();
        
    } catch (error) {
        console.error("❌ Interaction failed:", error.message);
        process.exit(1);
    }
    
    console.log("\n✅ Contract interaction completed successfully!");
}

// Allow running specific functions via command line
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.length > 0) {
        const interaction = new ContractInteraction();
        interaction.init().then(async () => {
            switch (args[0]) {
                case 'info':
                    await interaction.getContractInfo();
                    break;
                case 'balances':
                    await interaction.checkTokenBalances();
                    break;
                case 'validate':
                    await interaction.validateTokens();
                    break;
                case 'test':
                    await interaction.testContract();
                    break;
                default:
                    await main();
            }
        }).catch(console.error);
    } else {
        main().catch((error) => {
            console.error(error);
            process.exit(1);
        });
    }
}

module.exports = ContractInteraction;