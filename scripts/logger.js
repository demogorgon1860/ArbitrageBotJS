/**
 * Logger - Production-ready logging system
 */

const fs = require('fs-extra');
const path = require('path');

class Logger {
    constructor() {
        this.logsDir = path.join(__dirname, '../logs');
        this.init();
    }
    
    async init() {
        try {
            await fs.ensureDir(this.logsDir);
        } catch (error) {
            console.error('Failed to create logs directory:', error);
        }
    }
    
    log(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] [${level}] ${message}`;
        
        // Console output with colors
        const colors = {
            INFO: '\x1b[36m',
            SUCCESS: '\x1b[32m',
            WARNING: '\x1b[33m',
            ERROR: '\x1b[31m',
            DEBUG: '\x1b[35m'
        };
        
        console.log(`${colors[level] || ''}${logEntry}\x1b[0m`);
        
        if (data) {
            console.log(JSON.stringify(data, null, 2));
        }
        
        // File output
        this.writeToFile(level, logEntry, data);
    }
    
    async writeToFile(level, message, data) {
        try {
            const fileName = level === 'ERROR' ? 'error.log' : 'bot.log';
            const filePath = path.join(this.logsDir, fileName);
            
            let content = message;
            if (data) {
                if (data instanceof Error) {
                    content += `\n  Stack: ${data.stack}`;
                } else {
                    content += `\n  Data: ${JSON.stringify(data)}`;
                }
            }
            content += '\n';
            
            await fs.appendFile(filePath, content);
            
            // Rotate logs if too large
            await this.rotateLogs(filePath);
            
        } catch (error) {
            console.error('Failed to write log:', error);
        }
    }
    
    async rotateLogs(filePath) {
        try {
            const stats = await fs.stat(filePath);
            const maxSize = 10 * 1024 * 1024; // 10MB
            
            if (stats.size > maxSize) {
                const backupPath = `${filePath}.${Date.now()}`;
                await fs.move(filePath, backupPath);
                
                // Keep only last 5 backups
                const dir = path.dirname(filePath);
                const basename = path.basename(filePath);
                const files = await fs.readdir(dir);
                const backups = files.filter(f => f.startsWith(basename + '.'));
                
                if (backups.length > 5) {
                    backups.sort();
                    const toDelete = backups.slice(0, backups.length - 5);
                    for (const file of toDelete) {
                        await fs.remove(path.join(dir, file));
                    }
                }
            }
        } catch (error) {
            // Ignore rotation errors
        }
    }
    
    logInfo(message, data) {
        this.log('INFO', message, data);
    }
    
    logSuccess(message, data) {
        this.log('SUCCESS', message, data);
    }
    
    logWarning(message, data) {
        this.log('WARNING', message, data);
    }
    
    logError(message, error) {
        this.log('ERROR', message, error);
    }
    
    logDebug(message, data) {
        if (process.env.DEBUG === 'true') {
            this.log('DEBUG', message, data);
        }
    }
}

// Singleton
module.exports = new Logger();