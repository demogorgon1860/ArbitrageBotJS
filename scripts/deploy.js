const { ethers } = require("hardhat");
const fs = require('fs-extra');
const path = require('path');

async function main() {
    console.log("🚀 Deploying Arb contract to Polygon...");
    
    // Get deployer account
    const [deployer] = await ethers.getSigners();
    console.log("📝 Deploying with account:", deployer.address);
    
    // Check balance
    const balance = await deployer.getBalance();
    console.log("💰 Account balance:", ethers.utils.formatEther(balance), "MATIC");
    
    if (balance.lt(ethers.utils.parseEther("0.1"))) {
        console.log("⚠️  Warning: Low balance, may not be enough for deployment");
    }
    
    // Deploy contract
    console.log("🔨 Compiling and deploying contract...");
    
    const Arb = await ethers.getContractFactory("Arb");
    
    // Estimate gas
    const deploymentData = Arb.interface.encodeDeploy([]);
    const estimatedGas = await ethers.provider.estimateGas({
        data: deploymentData
    });
    
    console.log("⛽ Estimated gas:", estimatedGas.toString());
    
    // Deploy with gas estimation
    const arb = await Arb.deploy({
        gasLimit: estimatedGas.mul(120).div(100) // Add 20% buffer
    });
    
    console.log("⏳ Waiting for deployment...");
    await arb.deployed();
    
    console.log("✅ Arb contract deployed to:", arb.address);
    console.log("📋 Transaction hash:", arb.deployTransaction.hash);
    
    // Wait for confirmations
    console.log("⏳ Waiting for confirmations...");
    await arb.deployTransaction.wait(2);
    
    // Verify deployment
    console.log("🔍 Verifying deployment...");
    
    try {
        const contractInfo = await arb.getContractInfo();
        console.log("✅ Contract verified - Version:", contractInfo.version);
        
        // Test basic functionality
        const maticBalance = await arb.getBalance(ethers.constants.AddressZero);
        console.log("📊 Contract MATIC balance:", ethers.utils.formatEther(maticBalance));
        
    } catch (error) {
        console.log("❌ Contract verification failed:", error.message);
    }
    
    // Save deployment info
    const deploymentInfo = {
        network: "polygon",
        contractAddress: arb.address,
        deployerAddress: deployer.address,
        transactionHash: arb.deployTransaction.hash,
        blockNumber: arb.deployTransaction.blockNumber,
        gasUsed: (await arb.deployTransaction.wait()).gasUsed.toString(),
        deploymentTime: new Date().toISOString(),
        contractName: "Arb",
        version: "1.0.0"
    };
    
    // Ensure deployments directory exists
    const deploymentsDir = path.join(__dirname, '..', 'deployments');
    await fs.ensureDir(deploymentsDir);
    
    // Save deployment info
    const deploymentFile = path.join(deploymentsDir, `arb-${Date.now()}.json`);
    await fs.writeJson(deploymentFile, deploymentInfo, { spaces: 2 });
    
    console.log("💾 Deployment info saved to:", deploymentFile);
    
    // Update config with contract address
    try {
        const configPath = path.join(__dirname, '..', 'config', 'polygon.json');
        const config = await fs.readJson(configPath);
        
        if (!config.contracts) {
            config.contracts = {};
        }
        
        config.contracts.arb = {
            address: arb.address,
            deployed: new Date().toISOString()
        };
        
        await fs.writeJson(configPath, config, { spaces: 2 });
        console.log("📝 Config updated with contract address");
        
    } catch (error) {
        console.log("⚠️  Could not update config:", error.message);
    }
    
    console.log("\n" + "=".repeat(50));
    console.log("🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!");
    console.log("=".repeat(50));
    console.log("📋 Contract Address:", arb.address);
    console.log("🔗 Polygon Explorer:", `https://polygonscan.com/address/${arb.address}`);
    console.log("💰 Total Cost:", ethers.utils.formatEther(
        (await arb.deployTransaction.wait()).gasUsed.mul(arb.deployTransaction.gasPrice)
    ), "MATIC");
    console.log("=".repeat(50) + "\n");
}

// Handle deployment errors
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:", error);
        process.exit(1);
    });