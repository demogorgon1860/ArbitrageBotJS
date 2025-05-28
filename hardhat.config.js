require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-ethers");
require("dotenv").config();

// Collect all Polygon RPC endpoints from environment
const getPolygonRPCs = () => {
    const rpcs = [];
    
    // Add RPC endpoints from environment variables
    for (let i = 1; i <= 10; i++) {
        const rpc = process.env[`POLYGON_RPC_${i}`];
        if (rpc && rpc !== 'undefined') {
            rpcs.push(rpc);
        }
    }
    
    // Add API key based RPCs
    if (process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'undefined') {
        rpcs.push(`https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
    }
    
    if (process.env.INFURA_API_KEY && process.env.INFURA_API_KEY !== 'undefined') {
        rpcs.push(`https://polygon.infura.io/v3/${process.env.INFURA_API_KEY}`);
    }
    
    // Add public fallback RPCs
    const publicRPCs = [
        "https://rpc.ankr.com/polygon",
        "https://polygon-rpc.com",
        "https://rpc-mainnet.matic.network",
        "https://matic-mainnet.chainstacklabs.com",
        "https://polygon.llamarpc.com"
    ];
    
    rpcs.push(...publicRPCs);
    
    // Remove duplicates and return
    return [...new Set(rpcs.filter(Boolean))];
};

const polygonRPCs = getPolygonRPCs();

module.exports = {
    solidity: {
        version: "0.8.19",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200
            }
        }
    },
    networks: {
        polygon: {
            url: polygonRPCs[0] || "https://polygon-rpc.com",
            chainId: 137,
            gasPrice: "auto",
            gas: "auto",
            timeout: 60000
        },
        hardhat: {
            forking: {
                url: polygonRPCs[0] || "https://polygon-rpc.com",
                blockNumber: undefined
            },
            chainId: 137
        }
    },
    paths: {
        sources: "./contracts",
        tests: "./test",
        cache: "./cache",
        artifacts: "./artifacts"
    },
    mocha: {
        timeout: 60000
    },
    // Export RPC endpoints for use in scripts
    polygonRPCs
};