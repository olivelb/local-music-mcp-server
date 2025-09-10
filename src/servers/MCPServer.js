/**
 * MCP Server
 * Main Model Context Protocol server implementation
 */

const Logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

class MCPServer {
    constructor(config, services, controllers) {
        this.config = config;
        this.services = services;
        this.controllers = controllers;
        this.logger = new Logger({ context: 'MCP', level: config.getLogLevel() });
        
        this.pendingOperations = 0;
        this.isShuttingDown = false;
        
        this._setupProcessHandlers();
    }

    _setupProcessHandlers() {
        process.on('SIGINT', () => this._gracefulShutdown());
        process.on('SIGTERM', () => this._gracefulShutdown());
        process.on('unhandledRejection', (reason, promise) => {
            this.logger.error('Unhandled promise rejection', { reason, promise });
        });
        process.on('uncaughtException', (error) => {
            this.logger.error('Uncaught exception', { error: error.message, stack: error.stack });
            process.exit(1);
        });
    }

    async start() {
        try {
            this.logger.info('Starting MCP Server');
            
            // Start HTTP streaming server if available and not already running
            if (this.services.streaming && !this.services.streaming.isRunning) {
                await this.services.streaming.start();
            }
            
            this._startMessageLoop();
            
        } catch (error) {
            this.logger.error('Failed to start MCP Server', { error: error.message });
            throw error;
        }
    }

    _startMessageLoop() {
        this.logger.info('MCP Server ready for messages');
        
        process.stdin.setEncoding('utf8');
        
        let buffer = '';
        process.stdin.on('data', (chunk) => {
            buffer += chunk;
            
            // Process complete JSON messages
            let lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer
            
            for (const line of lines) {
                if (line.trim()) {
                    this._handleMessage(line.trim());
                }
            }
        });

        process.stdin.on('end', () => {
            this.logger.info('Input stream ended');
            // this._gracefulShutdown();
        });
    }

    async _handleMessage(message) {
        try {
            this.logger.debug('Received message', { message: message.substring(0, 100) });
            
            const cmd = JSON.parse(message);
            
            switch (cmd.method) {
                case 'initialize':
                    await this._handleInitialize(cmd);
                    break;
                    
                case 'tools/list':
                    await this._handleToolsList(cmd);
                    break;
                    
                case 'tools/call':
                    await this._handleToolCall(cmd);
                    break;
                    
                default:
                    this._sendError(cmd.id, `Unknown method: ${cmd.method}`);
            }
            
        } catch (error) {
            this.logger.error('Message handling error', { message, error: error.message });
            
            try {
                const cmd = JSON.parse(message);
                this._sendError(cmd.id, 'Internal server error');
            } catch {
                // Invalid JSON, can't respond properly
                this.logger.error('Invalid JSON message received');
            }
        }
    }

    async _handleInitialize(cmd) {
        const response = {
            jsonrpc: '2.0',
            id: cmd.id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: {
                    tools: {}
                },
                serverInfo: {
                    name: 'music-mcp-server',
                    version: '2.0.0'
                }
            }
        };
        
        this._sendResponse(response);
        this.logger.debug('Initialize response sent');
    }

    async _handleToolsList(cmd) {
        const tools = [
            {
                name: 'search_music',
                description: 'Search for music tracks in the library',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Search query' },
                        type: { type: 'string', enum: ['basic', 'exact'], description: 'Search type' },
                        limit: { type: 'integer', description: 'Maximum number of results', minimum: 1, maximum: 1000 },
                        fuzzy: { type: 'boolean', description: 'Enable fuzzy search' },
                        random: { type: 'boolean', description: 'Return random results from search' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'get_library_stats',
                description: 'Get music library statistics',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'manage_playlist',
                description: 'Create and manage playlists',
                inputSchema: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['create', 'list'], description: 'Action to perform' },
                        name: { type: 'string', description: 'Playlist name (required for create)' },
                        description: { type: 'string', description: 'Playlist description' }
                    },
                    required: ['action']
                }
            }
        ];

        // Add Chromecast tools if service is available
        if (this.services.chromecast?.isAvailable) {
            tools.push(
                {
                    name: 'list_chromecasts',
                    description: 'Discover and list available Chromecast devices',
                    inputSchema: { type: 'object', properties: {} }
                },
                {
                    name: 'connect_chromecast',
                    description: 'Connect to a specific Chromecast device',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            device_name: { type: 'string', description: 'Name of the Chromecast device' }
                        },
                        required: ['device_name']
                    }
                },
                {
                    name: 'play_track',
                    description: 'Play a specific track on the connected Chromecast device',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            track_id: { type: 'integer', description: 'ID of the track to play' },
                            device_name: { type: 'string', description: 'Optional: Chromecast device name' }
                        },
                        required: ['track_id']
                    }
                },
                {
                    name: 'play_multiple_tracks',
                    description: 'Play multiple tracks as a queue on the connected Chromecast device',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            tracks: { 
                                type: 'array', 
                                items: { type: 'integer' },
                                description: 'Array of track IDs to play' 
                            },
                            shuffle: { type: 'boolean', description: 'Whether to shuffle the tracks', default: false },
                            start_index: { type: 'integer', description: 'Index to start playing from', default: 0 },
                            device_name: { type: 'string', description: 'Optional: Chromecast device name to connect/use' }
                        },
                        required: ['tracks']
                    }
                },
                {
                    name: 'set_volume',
                    description: 'Set the volume level on the connected Chromecast device',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            volume: { type: 'number', description: 'Volume level (0.0 to 1.0)', minimum: 0.0, maximum: 1.0 }
                        },
                        required: ['volume']
                    }
                },
                {
                    name: 'pause_playback',
                    description: 'Pause the current playback on the Chromecast device',
                    inputSchema: { type: 'object', properties: {} }
                },
                {
                    name: 'resume_playback',
                    description: 'Resume the paused playback on the Chromecast device',
                    inputSchema: { type: 'object', properties: {} }
                },
                {
                    name: 'stop_playback',
                    description: 'Stop the current playback on the Chromecast device',
                    inputSchema: { type: 'object', properties: {} }
                },
                {
                    name: 'skip_to_next',
                    description: 'Skip to the next track in the queue',
                    inputSchema: { type: 'object', properties: {} }
                },
                {
                    name: 'skip_to_previous',
                    description: 'Skip to the previous track in the queue',
                    inputSchema: { type: 'object', properties: {} }
                },
                {
                    name: 'skip_to_track',
                    description: 'Skip to a specific track number in the queue',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            track_number: { type: 'integer', description: 'Track number in queue (1-based)', minimum: 1 }
                        },
                        required: ['track_number']
                    }
                },
                {
                    name: 'seek_to_position',
                    description: 'Seek to a specific position in the current track',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            position: { type: 'number', description: 'Position in seconds', minimum: 0 }
                        },
                        required: ['position']
                    }
                },
                {
                    name: 'manage_queue',
                    description: 'Manage the playback queue (add, remove, clear, shuffle, repeat)',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            action: { 
                                type: 'string', 
                                enum: ['add', 'remove', 'clear', 'shuffle', 'restore', 'repeat', 'info'],
                                description: 'Queue management action to perform' 
                            },
                            track_ids: { 
                                type: 'array', 
                                items: { type: 'integer' },
                                description: 'Track IDs for add action' 
                            },
                            index: { type: 'integer', description: 'Queue index for remove action' },
                            mode: { 
                                type: 'string', 
                                enum: ['none', 'one', 'all'],
                                description: 'Repeat mode for repeat action' 
                            }
                        },
                        required: ['action']
                    }
                },
                {
                    name: 'get_chromecast_status',
                    description: 'Get the current status of the connected Chromecast device including queue information',
                    inputSchema: { type: 'object', properties: {} }
                }
            );
        }

        const response = {
            jsonrpc: '2.0',
            id: cmd.id,
            result: { tools }
        };
        
        this._sendResponse(response);
        this.logger.debug('Tools list response sent', { toolCount: tools.length });
    }

    async _handleToolCall(cmd) {
        const { name, arguments: args } = cmd.params;
        
        this.pendingOperations++;
        
        try {
            this.logger.debug('Processing tool call', { name, args });
            
            let result;
            
            // Route to appropriate controller
            switch (name) {
                // Music tools
                case 'search_music':
                    result = await this.controllers.music.searchMusic(args);
                    break;
                case 'get_library_stats':
                    result = await this.controllers.music.getLibraryStats();
                    break;
                case 'manage_playlist':
                    result = await this.controllers.music.managePlaylist(args);
                    break;
                
                // Chromecast tools
                case 'list_chromecasts':
                    result = await this.controllers.chromecast.listChromecast();
                    break;
                case 'connect_chromecast':
                    result = await this.controllers.chromecast.connectChromecast(args);
                    break;
                case 'play_track':
                    result = await this.controllers.chromecast.playTrack(args);
                    break;
                case 'play_multiple_tracks':
                    result = await this.controllers.chromecast.playMultipleTracks(args);
                    break;
                case 'set_volume':
                    result = await this.controllers.chromecast.setVolume(args);
                    break;
                case 'pause_playback':
                    result = await this.controllers.chromecast.pausePlayback();
                    break;
                case 'resume_playback':
                    result = await this.controllers.chromecast.resumePlayback();
                    break;
                case 'stop_playback':
                    result = await this.controllers.chromecast.stopPlayback();
                    break;
                case 'skip_to_next':
                    result = await this.controllers.chromecast.skipToNext();
                    break;
                case 'skip_to_previous':
                    result = await this.controllers.chromecast.skipToPrevious();
                    break;
                case 'skip_to_track':
                    result = await this.controllers.chromecast.skipToTrack(args);
                    break;
                case 'seek_to_position':
                    result = await this.controllers.chromecast.seekToPosition(args);
                    break;
                case 'manage_queue':
                    result = await this.controllers.chromecast.manageQueue(args);
                    break;
                case 'get_chromecast_status':
                    result = await this.controllers.chromecast.getChromecastStatus();
                    break;
                
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
            
            const response = {
                jsonrpc: '2.0',
                id: cmd.id,
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }]
                }
            };
            
            this._sendResponse(response);
            this.logger.debug('Tool call response sent', { name });
            
        } catch (error) {
            this.logger.error('Tool call failed', { name, error: error.message });
            this._sendError(cmd.id, `Tool execution failed: ${error.message}`);
            
        } finally {
            this.pendingOperations--;
            
            if (this.isShuttingDown && this.pendingOperations === 0) {
                this._finalizeShutdown();
            }
        }
    }

    _sendResponse(response) {
        const message = JSON.stringify(response);
        process.stdout.write(message + '\n');
    }

    _sendError(id, message) {
        const response = {
            jsonrpc: '2.0',
            id,
            error: {
                code: -1,
                message
            }
        };
        this._sendResponse(response);
    }

    async _gracefulShutdown() {
        if (this.isShuttingDown) return;
        
        this.isShuttingDown = true;
        this.logger.info('Graceful shutdown initiated', { pendingOperations: this.pendingOperations });
        
        if (this.pendingOperations === 0) {
            this._finalizeShutdown();
        } else {
            // Wait for pending operations with timeout
            setTimeout(() => {
                this.logger.warn('Shutdown timeout reached, forcing exit');
                this._finalizeShutdown();
            }, 5000);
        }
    }

    async _finalizeShutdown() {
        try {
            this.logger.info('Finalizing shutdown');
            
            // Close services
            if (this.services.streaming) {
                await this.services.streaming.stop();
            }
            
            if (this.services.chromecast) {
                this.services.chromecast.disconnect();
            }
            
            if (this.services.database) {
                this.services.database.close();
            }
            
            this.logger.info('Shutdown complete');
            
        } catch (error) {
            this.logger.error('Shutdown error', { error: error.message });
        } finally {
            process.exit(0);
        }
    }
}

module.exports = MCPServer;
