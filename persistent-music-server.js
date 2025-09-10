#!/usr/bin/env node
/**
 * Persistent Music Server
 * 
 * This server runs independently in the background to provide continuous
 * music playback capabilities. It survives LM Studio disconnections and
 * maintains Chromecast connections and playback state.
 * 
 * Features:
 * - Background operation with PID management
 * - HTTP MCP endpoint for tool forwarding
 * - Chromecast connection persistence
 * - Queue management and playback control
 * - Comprehensive logging
 * 
 * @version 1.0.0
 * @author Music MCP Server
 */

const Application = require('./src/index');
const fs = require('fs');
const path = require('path');

// Set environment for persistent operation
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'info';
process.env.PERSISTENT_MODE = 'true';

const pidFile = path.join(__dirname, 'data', 'music-server.pid');
const logFile = path.join(__dirname, 'data', 'music-server.log');

class PersistentMusicServer {
    constructor() {
        this.app = null;
        this.isRunning = false;
    }

    async start() {
        try {
            console.error('🚀 Starting Persistent Music Server...');
            
            // Save PID for management
            fs.writeFileSync(pidFile, process.pid.toString());
            
            // Redirect logs
            const logStream = fs.createWriteStream(logFile, { flags: 'a' });
            const originalWrite = process.stderr.write;
            process.stderr.write = function(chunk, encoding, callback) {
                logStream.write(chunk, encoding);
                return originalWrite.call(process.stderr, chunk, encoding, callback);
            };

            // Initialize application
            this.app = new Application();
            await this.app.initialize();
            
            // Register MCP handlers with streaming server for HTTP access
            if (this.app.services.streaming && this.app.controllers) {
                const mcpHandlers = {
                    handleMessage: async (message) => {
                        return await this.handleMCPMessage(message);
                    }
                };
                this.app.services.streaming.setMCPHandlers(mcpHandlers);
            }
            
            await this.app.start();
            
            this.isRunning = true;
            console.error('✅ Persistent Music Server running on port 8765');
            console.error('🎵 Server will continue running even when LM Studio disconnects');
            console.error('🔧 PID:', process.pid, '| Log file:', logFile);
            
            // Keep the process alive
            this.keepAlive();
            
        } catch (error) {
            console.error('❌ Failed to start persistent server:', error.message);
            this.cleanup();
            process.exit(1);
        }
    }

    async handleMCPMessage(message) {
        try {
            if (message.method === 'tools/call') {
                const toolName = message.params.name;
                const args = message.params.arguments;
                
                // Route to appropriate controller
                if (toolName === 'server_status') {
                    return {
                        jsonrpc: "2.0",
                        id: message.id,
                        result: {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    status: "healthy",
                                    message: "Persistent music server is running and responsive",
                                    pid: process.pid,
                                    port: 8765,
                                    uptime: process.uptime(),
                                    memory: process.memoryUsage()
                                }, null, 2)
                            }]
                        }
                    };
                } else if (toolName.startsWith('play_') || 
                          toolName.includes('chromecast') || 
                          toolName === 'skip_to_next' || 
                          toolName === 'skip_to_previous' || 
                          toolName === 'skip_to_track' ||
                          toolName === 'set_volume' || 
                          toolName === 'list_chromecasts' || 
                          toolName === 'get_playlist_status' ||
                          toolName === 'connect_chromecast' ||
                          toolName === 'get_chromecast_status' ||
                          toolName === 'pause_playback' ||
                          toolName === 'resume_playback' ||
                          toolName === 'stop_playback' ||
                          toolName === 'seek_to_position' ||
                          toolName === 'manage_queue') {
                    const result = await this.app.controllers.chromecast[this.mapToolToMethod(toolName)](args);
                    return {
                        jsonrpc: "2.0",
                        id: message.id,
                        result: {
                            content: [{
                                type: "text",
                                text: JSON.stringify(result, null, 2)
                            }]
                        }
                    };
                } else if (toolName.includes('search') || 
                          toolName.includes('library') || 
                          toolName.includes('playlist') ||
                          toolName === 'get_library_stats' ||
                          toolName === 'manage_playlist') {
                    const result = await this.app.controllers.music[this.mapToolToMethod(toolName)](args);
                    return {
                        jsonrpc: "2.0",
                        id: message.id,
                        result: {
                            content: [{
                                type: "text",
                                text: JSON.stringify(result, null, 2)
                            }]
                        }
                    };
                }
            } else if (message.method === 'tools/list') {
                // Return available tools
                const tools = [
                    { name: 'play_multiple_tracks', description: 'Play multiple tracks in sequence' },
                    { name: 'search_music', description: 'Search for music tracks' },
                    { name: 'list_chromecasts', description: 'List available Chromecast devices' },
                    { name: 'get_chromecast_status', description: 'Get Chromecast playback status' },
                    { name: 'skip_to_next', description: 'Skip to next track' },
                    { name: 'set_volume', description: 'Set playback volume' }
                ];
                
                return {
                    jsonrpc: "2.0",
                    id: message.id,
                    result: { tools }
                };
            }
            
            return {
                jsonrpc: "2.0",
                id: message.id,
                error: {
                    code: -32601,
                    message: `Method not found: ${message.method}`
                }
            };
            
        } catch (error) {
            return {
                jsonrpc: "2.0",
                id: message.id,
                error: {
                    code: -32603,
                    message: error.message
                }
            };
        }
    }

    mapToolToMethod(toolName) {
        const mapping = {
            // Chromecast Control Tools
            'play_multiple_tracks': 'playMultipleTracks',
            'play_track': 'playTrack',
            'list_chromecasts': 'listChromecast',
            'connect_chromecast': 'connectChromecast',
            'get_chromecast_status': 'getChromecastStatus',
            'get_playlist_status': 'getChromecastStatus',
            
            // Playback Control Tools
            'pause_playback': 'pausePlayback',
            'resume_playback': 'resumePlayback',
            'stop_playback': 'stopPlayback',
            'skip_to_next': 'skipToNext',
            'skip_to_previous': 'skipToPrevious',
            'skip_to_track': 'skipToTrack',
            'seek_to_position': 'seekToPosition',
            
            // Volume Control
            'set_volume': 'setVolume',
            
            // Queue Management
            'manage_queue': 'manageQueue',
            
            // Music Library Tools
            'search_music': 'searchMusic',
            'get_library_stats': 'getLibraryStats',
            'manage_playlist': 'managePlaylist'
        };
        return mapping[toolName] || toolName;
    }

    keepAlive() {
        // Prevent the process from exiting
        setInterval(() => {
            if (this.isRunning) {
                // Check if Chromecast is still connected and playing
                const status = this.app.services.chromecast.getStatus();
                if (status.connected) {
                    console.error(`🎵 [${new Date().toISOString()}] Music server alive - Player: ${status.playerState}, Queue: ${status.queue?.size || 0} tracks`);
                }
            }
        }, 30000); // Log every 30 seconds
    }

    cleanup() {
        try {
            if (fs.existsSync(pidFile)) {
                fs.unlinkSync(pidFile);
            }
        } catch (error) {
            console.error('Warning: Failed to cleanup PID file:', error.message);
        }
    }

    async shutdown() {
        console.error('🛑 Shutting down persistent music server...');
        this.isRunning = false;
        
        try {
            if (this.app?.services?.chromecast) {
                await this.app.services.chromecast.disconnect();
            }
            if (this.app?.services?.streaming) {
                await this.app.services.streaming.stop();
            }
        } catch (error) {
            console.error('Warning: Error during shutdown:', error.message);
        }
        
        this.cleanup();
        process.exit(0);
    }
}

// Handle graceful shutdown
const server = new PersistentMusicServer();

process.on('SIGINT', () => server.shutdown());
process.on('SIGTERM', () => server.shutdown());
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error.message);
    server.cleanup();
    process.exit(1);
});

// Start the server
server.start();
