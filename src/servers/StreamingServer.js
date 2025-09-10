/**
 * HTTP Streaming Server
 * Serves audio files to Chromecast devices with proper range support
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const statAsync = promisify(fs.stat);

class StreamingServer {
    constructor(config, databaseService, logger) {
        this.config = config;
        this.database = databaseService;
        this.logger = logger || console;
        
        this.app = express();
        this.server = null;
        this.isRunning = false;
        this.mcpHandlers = null;
        
        this._setupMiddleware();
        this._setupRoutes();
    }

    setMCPHandlers(handlers) {
        this.mcpHandlers = handlers;
        this.logger.debug('MCP handlers registered with streaming server');
    }

    _setupMiddleware() {
        // CORS middleware for Chromecast
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Range, Content-Type');
            
            if (req.method === 'OPTIONS') {
                res.sendStatus(200);
            } else {
                next();
            }
        });

        // Request logging
        this.app.use((req, res, next) => {
            this.logger.debug('HTTP request', { 
                method: req.method, 
                url: req.url,
                userAgent: req.headers['user-agent']
            });
            next();
        });

        // Error handling
        this.app.use((error, req, res, next) => {
            this.logger.error('HTTP server error', { 
                error: error.message,
                url: req.url 
            });
            res.status(500).json({ error: 'Internal server error' });
        });
    }

    _setupRoutes() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                port: this.config.server.port,
                directories: this.config.musicDirectories.length,
                database: this.database.isHealthy()
            });
        });

        // MCP endpoint for persistent server communication
        this.app.use(express.json());
        this.app.post('/mcp', async (req, res) => {
            try {
                this.logger.debug('MCP HTTP request', { 
                    method: req.body.method,
                    id: req.body.id 
                });

                // Forward to MCP server handlers
                if (this.mcpHandlers && typeof this.mcpHandlers.handleMessage === 'function') {
                    const response = await this.mcpHandlers.handleMessage(req.body);
                    res.json(response);
                } else {
                    res.status(503).json({
                        jsonrpc: "2.0",
                        id: req.body.id || 1,
                        error: {
                            code: -32603,
                            message: "MCP handlers not available"
                        }
                    });
                }
            } catch (error) {
                this.logger.error('MCP HTTP error', { error: error.message });
                res.status(500).json({
                    jsonrpc: "2.0",
                    id: req.body.id || 1,
                    error: {
                        code: -32603,
                        message: error.message
                    }
                });
            }
        });

        // Stream audio file by track ID
        this.app.get('/stream/:trackId.:ext?', async (req, res) => {
            try {
                const trackId = parseInt(req.params.trackId);
                
                if (isNaN(trackId)) {
                    return res.status(400).json({ error: 'Invalid track ID' });
                }

                // Get track from database
                const track = this.database.getTrackById(trackId);
                const filePath = track.filepath;

                this.logger.debug('Streaming request', { 
                    trackId, 
                    filePath: path.basename(filePath) 
                });

                // Check if file exists
                if (!fs.existsSync(filePath)) {
                    this.logger.warn('Audio file not found', { filePath });
                    return res.status(404).json({ error: 'Audio file not found' });
                }

                // Get file stats
                const stats = await statAsync(filePath);
                const fileSize = stats.size;

                // Set appropriate headers
                const ext = path.extname(filePath).toLowerCase();
                const contentType = this._getContentType(ext);
                
                res.set({
                    'Content-Type': contentType,
                    'Content-Length': fileSize,
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'public, max-age=3600',
                    'Last-Modified': stats.mtime.toUTCString(),
                    'ETag': `"${stats.size}-${stats.mtime.getTime()}"`
                });

                // Handle range requests for seeking
                const range = req.headers.range;
                if (range) {
                    const parts = range.replace(/bytes=/, "").split("-");
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                    const chunkSize = (end - start) + 1;
                    
                    res.status(206);
                    res.set({
                        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                        'Content-Length': chunkSize
                    });
                    
                    const stream = fs.createReadStream(filePath, { start, end });
                    stream.pipe(res);
                } else {
                    // Stream entire file
                    const stream = fs.createReadStream(filePath);
                    stream.pipe(res);
                }

                this.logger.debug('Streaming started', { 
                    trackId,
                    filename: path.basename(filePath),
                    contentType,
                    range: !!range
                });

            } catch (error) {
                this.logger.error('Streaming error', { 
                    trackId: req.params.trackId, 
                    error: error.message 
                });
                
                if (error.name === 'NotFoundError') {
                    res.status(404).json({ error: 'Track not found' });
                } else {
                    res.status(500).json({ error: 'Internal server error' });
                }
            }
        });

        // 404 handler
        this.app.use('*', (req, res) => {
            res.status(404).json({ error: 'Endpoint not found' });
        });
    }

    _getContentType(ext) {
        const contentTypes = {
            '.mp3': 'audio/mpeg',
            '.flac': 'audio/flac',
            '.wav': 'audio/wav',
            '.aac': 'audio/aac',
            '.m4a': 'audio/mp4',
            '.ogg': 'audio/ogg',
            '.wma': 'audio/x-ms-wma'
        };
        return contentTypes[ext] || 'audio/mpeg';
    }

    async start(port = null) {
        const listenPort = port || this.config.server.port;
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(listenPort, '0.0.0.0', (error) => {
                if (error) {
                    this.logger.error('Failed to start streaming server', { error: error.message });
                    reject(error);
                } else {
                    this.isRunning = true;
                    this.logger.info('Streaming server started', { 
                        port: listenPort,
                        host: '0.0.0.0'
                    });
                    resolve();
                }
            });

            this.server.on('error', (error) => {
                this.logger.error('Streaming server error', { error: error.message });
                reject(error);
            });
        });
    }

    async stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.isRunning = false;
                    this.logger.info('Streaming server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    getBaseUrl() {
        return this.config.getBaseUrl();
    }

    isHealthy() {
        return this.isRunning && this.server && this.server.listening;
    }
}

module.exports = StreamingServer;
