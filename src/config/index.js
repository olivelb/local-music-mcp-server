/**
 * Configuration Manager
 * Centralized configuration management following Node.js best practices
 */

const path = require('path');
const fs = require('fs');

class Config {
    constructor() {
        this.projectRoot = path.resolve(__dirname, '..', '..');
        this.dataDir = path.join(this.projectRoot, 'data');
        this.musicDirectories = [
            'C:\\Users\\lemol\\Music',
            'K:/Musique hall',
            'K:/Musique Hall',
            'E:/Musiques'
        ];
        
        // Ensure data directory exists
        this._ensureDataDirectory();
        
        // Load environment-specific config
        this._loadEnvironmentConfig();
    }

    _ensureDataDirectory() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    _loadEnvironmentConfig() {
        const env = process.env.NODE_ENV || 'development';
        
        // Load environment-specific settings
        this.server = {
            port: process.env.HTTP_PORT || 8765,
            host: process.env.HTTP_HOST || '192.168.1.103',
            timeout: process.env.REQUEST_TIMEOUT || 30000
        };

        this.chromecast = {
            discoveryTimeout: process.env.CHROMECAST_DISCOVERY_TIMEOUT || 1000,
            defaultDevice: process.env.DEFAULT_CHROMECAST_DEVICE || null,
            verificationTimeout: process.env.CHROMECAST_VERIFICATION_TIMEOUT || 1600
        };

        this.database = {
            path: path.join(this.dataDir, 'music_library.db'),
            connectionTimeout: process.env.DB_TIMEOUT || 5000,
            busyTimeout: process.env.DB_BUSY_TIMEOUT || 1000
        };

        this.logging = {
            level: process.env.LOG_LEVEL || (env === 'development' ? 'debug' : 'info'),
            enableConsole: process.env.ENABLE_CONSOLE_LOG !== 'false',
            enableFile: process.env.ENABLE_FILE_LOG === 'true'
        };
    }

    // Getters for backward compatibility
    getDataDirectory() {
        return this.dataDir;
    }

    getDbPath() {
        return this.database.path;
    }

    getMusicDirectories() {
        return this.musicDirectories;
    }

    getHttpPort() {
        return this.server.port;
    }

    getHttpHost() {
        return this.server.host;
    }

    getBaseUrl() {
        return `http://${this.server.host}:${this.server.port}`;
    }

    updateServerPort(port) {
        this.server.port = port;
    }

    getDefaultChromecast() {
        return this.chromecast.defaultDevice;
    }

    getChromecastDiscoveryTimeout() {
        return this.chromecast.discoveryTimeout;
    }

    getChromecastVerificationTimeout() {
        return this.chromecast.verificationTimeout;
    }

    getLogLevel() {
        return this.logging.level;
    }

    // Environment helpers
    isDevelopment() {
        return process.env.NODE_ENV === 'development';
    }

    isProduction() {
        return process.env.NODE_ENV === 'production';
    }

    isTest() {
        return process.env.NODE_ENV === 'test';
    }
}

module.exports = Config;
