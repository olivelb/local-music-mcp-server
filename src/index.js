#!/usr/bin/env node
/**
 * Music MCP Server - Main Entry Point
 * Refactored modular architecture following Node.js best practices
 */

const path = require('path');

// Import configuration and utilities
const Config = require('./config');
const Logger = require('./utils/logger');

// Import services
const DatabaseService = require('./services/DatabaseService');
const ChromecastServiceQueue = require('./services/ChromecastServiceQueue');
const ConnectionManager = require('./services/ConnectionManager');

// Import controllers
const MusicController = require('./controllers/MusicController');
const ChromecastController = require('./controllers/ChromecastController');

// Import MCP server
const MCPServer = require('./servers/MCPServer');

/**
 * Application Bootstrap
 */
class Application {
    constructor() {
        this.config = null;
        this.logger = null;
        this.services = {};
        this.controllers = {};
        this.server = null;
    }

    async initialize() {
        try {
            // Initialize configuration
            this.config = new Config();
            
            // Initialize logger
            this.logger = new Logger({
                level: this.config.getLogLevel(),
                enableConsole: true,
                context: 'App'
            });

            this.logger.info('Initializing Music MCP Server', {
                nodeVersion: process.version,
                environment: process.env.NODE_ENV || 'development'
            });

            // Initialize services
            await this._initializeServices();
            
            // Initialize controllers
            this._initializeControllers();
            
            // Initialize MCP server
            this.server = new MCPServer(this.config, this.services, this.controllers);

            this.logger.info('Application initialized successfully');

        } catch (error) {
            console.error('❌ Application initialization failed:', error.message);
            process.exit(1);
        }
    }

    async _initializeServices() {
        try {
            // Database Service
            this.logger.info('Initializing database service');
            this.services.database = new DatabaseService(
                this.config, 
                this.logger.child('Database')
            );

            // HTTP Streaming Server (for Chromecast playback)
            this.logger.info('Initializing HTTP streaming server');
            const StreamingServer = require('./servers/StreamingServer');
            this.services.streaming = new StreamingServer(
                this.config,
                this.services.database,
                this.logger.child('Streaming')
            );

            // Connection Manager
            this.services.connectionManager = new ConnectionManager(
                this.config.getDataDirectory(),
                this.logger.child('Connection')
            );

            // Chromecast Service with Native Queue
            this.logger.info('Initializing Chromecast service with native queue support');
            this.services.chromecast = new ChromecastServiceQueue(
                this.config,
                this.logger.child('Chromecast'),
                this.services.connectionManager
            );

            this.logger.info('Services initialized', {
                database: this.services.database.isHealthy(),
                chromecast: this.services.chromecast.isHealthy(),
                streaming: 'ready'
            });

        } catch (error) {
            this.logger.error('Service initialization failed', { error: error.message });
            throw error;
        }
    }

    _initializeControllers() {
        try {
            // Music Controller
            this.controllers.music = new MusicController(
                this.services.database,
                this.logger.child('MusicController')
            );

            // Chromecast Controller
            this.controllers.chromecast = new ChromecastController(
                this.services.chromecast,
                this.services.database,
                this.config,
                this.logger.child('ChromecastController')
            );

            this.logger.info('Controllers initialized');

        } catch (error) {
            this.logger.error('Controller initialization failed', { error: error.message });
            throw error;
        }
    }

    async start() {
        try {
            await this.server.start();
        } catch (error) {
            this.logger.error('Failed to start server', { error: error.message });
            process.exit(1);
        }
    }

    // Health check for monitoring
    getHealthStatus() {
        return {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            services: {
                database: this.services.database?.isHealthy() || false,
                chromecast: this.services.chromecast?.isHealthy() || false
            },
            version: '2.0.0'
        };
    }
}

/**
 * Main execution
 */
async function main() {
    // Handle uncaught errors gracefully
    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled Rejection at:', promise, 'reason:', reason);
        process.exit(1);
    });

    process.on('uncaughtException', (error) => {
        console.error('Uncaught Exception:', error);
        process.exit(1);
    });

    // Create and start application
    const app = new Application();
    await app.initialize();
    await app.start();
}

// Start the application
if (require.main === module) {
    main().catch((error) => {
        console.error('❌ Application startup failed:', error);
        process.exit(1);
    });
}

module.exports = Application;
