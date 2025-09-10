#!/usr/bin/env node
/**
 * LM Studio Music Interface - Minimal & Fast
 * 
 * This is the main interface between LM Studio and the persistent music server.
 * It handles MCP protocol methods with ultra-fast responses and forwards
 * music commands to the background server.
 * 
 * Features:
 * - Instant MCP protocol responses (~20ms)
 * - Automatic server detection and management
 * - Comprehensive music tool support (21 tools)
 * - No timeout issues with LM Studio
 * 
 * @version 1.0.0
 * @author Music MCP Server
 */

// Core dependencies
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Configuration
const pidFile = path.join(__dirname, 'data', 'music-server.pid');
const SERVER_PORT = 8765;
const FORWARD_TIMEOUT = 3000;

/**
 * Complete tool definitions for the Music MCP Server
 * Total: 21 tools across 7 categories
 */
const TOOLS = [
    // Server Management Tools
    {
        name: "start_music_server",
        description: "Start the persistent music server in the background",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "stop_music_server", 
        description: "Stop the persistent music server",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "server_status",
        description: "Check the status of the persistent music server",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    
    // Chromecast Discovery & Connection
    {
        name: "list_chromecasts",
        description: "List all available Chromecast devices on the network",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "connect_chromecast",
        description: "Connect to a specific Chromecast device",
        inputSchema: {
            type: "object",
            properties: {
                device_name: { type: "string", description: "Name of the Chromecast device to connect to" }
            },
            required: ["device_name"]
        }
    },
    {
        name: "get_chromecast_status",
        description: "Get current Chromecast connection and playback status",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    
    // Music Library & Search
    {
        name: "search_music",
        description: "Search for music tracks by artist, title, album, or any text",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query for artist, title, album, or any text" },
                type: { type: "string", description: "Search type: 'basic', 'exact', 'fuzzy'", enum: ["basic", "exact", "fuzzy"], default: "basic" },
                limit: { type: "number", description: "Maximum number of results (1-50)", minimum: 1, maximum: 50, default: 10 },
                random: { type: "boolean", description: "Return random results", default: false }
            },
            required: ["query"]
        }
    },
    {
        name: "get_library_stats",
        description: "Get comprehensive statistics about the music library",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    
    // Single Track Playback
    {
        name: "play_track",
        description: "Play a single track on a Chromecast device",
        inputSchema: {
            type: "object",
            properties: {
                track_id: { type: "integer", description: "ID of the track to play", minimum: 1 },
                device_name: { type: "string", description: "Chromecast device name (optional if already connected)" }
            },
            required: ["track_id"]
        }
    },
    
    // Multi-Track Queue Playback
    {
        name: "play_multiple_tracks",
        description: "Play a queue of multiple tracks on a Chromecast device with native Cast queue support",
        inputSchema: {
            type: "object",
            properties: {
                tracks: { 
                    type: "array", 
                    items: { type: "integer" }, 
                    description: "Array of track IDs to play",
                    minItems: 1
                },
                device_name: { type: "string", description: "Chromecast device name" },
                shuffle: { type: "boolean", description: "Shuffle the tracks", default: false },
                start_index: { type: "integer", description: "Index of track to start with (0-based)", minimum: 0, default: 0 }
            },
            required: ["tracks", "device_name"]
        }
    },
    
    // Playback Control
    {
        name: "pause_playback",
        description: "Pause current playback on the connected Chromecast",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "resume_playback",
        description: "Resume paused playback on the connected Chromecast",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "stop_playback",
        description: "Stop current playback on the connected Chromecast",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "skip_to_next",
        description: "Skip to the next track in the queue", 
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "skip_to_previous",
        description: "Skip to the previous track in the queue",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "skip_to_track",
        description: "Skip to a specific track number in the queue",
        inputSchema: {
            type: "object",
            properties: {
                track_number: { type: "integer", description: "Track number in the queue (1-based)", minimum: 1 }
            },
            required: ["track_number"]
        }
    },
    {
        name: "seek_to_position",
        description: "Seek to a specific position in the current track",
        inputSchema: {
            type: "object",
            properties: {
                position: { type: "number", description: "Position in seconds", minimum: 0 }
            },
            required: ["position"]
        }
    },
    
    // Volume Control
    {
        name: "set_volume",
        description: "Set the volume of the Chromecast device",
        inputSchema: {
            type: "object",
            properties: {
                volume: { type: "number", description: "Volume level (0.0 to 1.0)", minimum: 0, maximum: 1 }
            },
            required: ["volume"]
        }
    },
    
    // Queue Management
    {
        name: "manage_queue",
        description: "Manage the playback queue (add, remove, clear, shuffle, etc.)",
        inputSchema: {
            type: "object",
            properties: {
                action: { 
                    type: "string", 
                    description: "Queue action to perform",
                    enum: ["add", "remove", "clear", "shuffle", "restore", "repeat", "info"]
                },
                trackIds: { 
                    type: "array", 
                    items: { type: "integer" },
                    description: "Track IDs for add operation"
                },
                index: { type: "integer", description: "Index for remove operation", minimum: 0 },
                mode: { 
                    type: "string", 
                    description: "Repeat mode for repeat action",
                    enum: ["none", "one", "all"]
                }
            },
            required: ["action"]
        }
    },
    
    // Playlist Status & Info
    {
        name: "get_playlist_status",
        description: "Get current playback status, queue information, and now playing details",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    
    // Playlist Management
    {
        name: "manage_playlist",
        description: "Create, list, or manage saved playlists",
        inputSchema: {
            type: "object",
            properties: {
                action: { 
                    type: "string", 
                    description: "Playlist action to perform",
                    enum: ["create", "list", "delete", "load"]
                },
                playlist_id: { type: "integer", description: "Playlist ID for specific operations" },
                name: { type: "string", description: "Playlist name for create operation" },
                description: { type: "string", description: "Playlist description for create operation" }
            },
            required: ["action"]
        }
    }
];

function handleRequest(input) {
    const method = input.method;
    const id = input.id;

    // Handle all MCP protocol methods SYNCHRONOUSLY
    if (method === 'initialize') {
        return {
            jsonrpc: "2.0",
            id: id,
            result: {
                protocolVersion: "2024-11-05",
                serverInfo: { name: "music-mcp-interface", version: "1.0.0" },
                capabilities: { tools: {} }
            }
        };
    }

    if (method === 'tools/list') {
        return {
            jsonrpc: "2.0",
            id: id,
            result: { tools: TOOLS }
        };
    }

    if (method === 'tools/call') {
        const toolName = input.params.name;

        // Handle server management tools synchronously
        if (toolName === 'start_music_server') {
            return handleStartServer(id);
        }
        if (toolName === 'stop_music_server') {
            return handleStopServer(id);
        }
        if (toolName === 'server_status') {
            return handleServerStatus(id);
        }

        // For music tools, check if server is running by trying to connect
        // Return promise for async handling
        return checkAndForwardToServer(input);
    }

    // Default response for unknown methods
    return {
        jsonrpc: "2.0",
        id: id,
        error: { code: -32601, message: `Method not found: ${method}` }
    };
}

function handleStartServer(id) {
    try {
        // Check if already running
        if (fs.existsSync(pidFile)) {
            const pid = parseInt(fs.readFileSync(pidFile, 'utf8'));
            try {
                process.kill(pid, 0);
                return {
                    jsonrpc: "2.0",
                    id: id,
                    result: {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                status: "already_running",
                                message: `Music server already running (PID: ${pid})`
                            }, null, 2)
                        }]
                    }
                };
            } catch (e) {
                fs.unlinkSync(pidFile);
            }
        }

        // Start new server
        const serverProcess = spawn('node', ['persistent-music-server.js'], {
            cwd: __dirname,
            detached: true,
            stdio: 'ignore'
        });
        serverProcess.unref();

        return {
            jsonrpc: "2.0",
            id: id,
            result: {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        status: "started",
                        message: "Music server started successfully",
                        pid: serverProcess.pid
                    }, null, 2)
                }]
            }
        };
    } catch (error) {
        return {
            jsonrpc: "2.0",
            id: id,
            error: { code: -32603, message: `Failed to start server: ${error.message}` }
        };
    }
}

function handleStopServer(id) {
    try {
        if (!fs.existsSync(pidFile)) {
            return {
                jsonrpc: "2.0",
                id: id,
                result: {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ status: "not_running", message: "Server not running" }, null, 2)
                    }]
                }
            };
        }

        const pid = parseInt(fs.readFileSync(pidFile, 'utf8'));
        process.kill(pid, 'SIGTERM');
        fs.unlinkSync(pidFile);

        return {
            jsonrpc: "2.0",
            id: id,
            result: {
                content: [{
                    type: "text",
                    text: JSON.stringify({ status: "stopped", message: "Server stopped" }, null, 2)
                }]
            }
        };
    } catch (error) {
        return {
            jsonrpc: "2.0",
            id: id,
            result: {
                content: [{
                    type: "text",
                    text: JSON.stringify({ status: "error", message: error.message }, null, 2)
                }]
            }
        };
    }
}

function handleServerStatus(id) {
    let status = { running: false, pid: null };
    
    if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8'));
        try {
            process.kill(pid, 0);
            status = { running: true, pid: pid };
        } catch (e) {
            fs.unlinkSync(pidFile);
        }
    }

    return {
        jsonrpc: "2.0",
        id: id,
        result: {
            content: [{
                type: "text",
                text: JSON.stringify({
                    status: status.running ? "healthy" : "stopped",
                    details: status
                }, null, 2)
            }]
        }
    };
}

function startServerIfNeeded() {
    if (!fs.existsSync(pidFile)) {
        setImmediate(() => {
            const serverProcess = spawn('node', ['persistent-music-server.js'], {
                cwd: __dirname,
                detached: true,
                stdio: 'ignore'
            });
            serverProcess.unref();
        });
    }
}

function checkAndForwardToServer(input) {
    return new Promise((resolve) => {
        // Try to forward immediately
        const postData = JSON.stringify(input);
        const options = {
            hostname: 'localhost',
            port: 8765,
            path: '/mcp',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 3000
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    resolve(response);
                } catch (error) {
                    resolve({
                        jsonrpc: "2.0",
                        id: input.id,
                        error: { code: -32603, message: `Server response error: ${error.message}` }
                    });
                }
            });
        });

        req.on('error', (error) => {
            // Server not responding, start it and return message
            startServerIfNeeded();
            resolve({
                jsonrpc: "2.0",
                id: input.id,
                result: {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            status: "server_starting",
                            message: "Music server is starting. Please try the command again in a moment.",
                            info: "Use start_music_server to ensure server is ready before music commands"
                        }, null, 2)
                    }]
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({
                jsonrpc: "2.0",
                id: input.id,
                result: {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            status: "timeout",
                            message: "Music server response timed out. Please try again."
                        }, null, 2)
                    }]
                }
            });
        });

        req.write(postData);
        req.end();
    });
}

function forwardToServer(input) {
    return new Promise((resolve) => {
        const postData = JSON.stringify(input);
        const options = {
            hostname: 'localhost',
            port: 8765,
            path: '/mcp',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 5000
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    resolve(response);
                } catch (error) {
                    resolve({
                        jsonrpc: "2.0",
                        id: input.id,
                        error: { code: -32603, message: `Server response error: ${error.message}` }
                    });
                }
            });
        });

        req.on('error', (error) => {
            resolve({
                jsonrpc: "2.0",
                id: input.id,
                result: {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            status: "server_unavailable",
                            message: "Music server is not responding. Please try start_music_server first.",
                            error: error.message
                        }, null, 2)
                    }]
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({
                jsonrpc: "2.0",
                id: input.id,
                result: {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            status: "timeout",
                            message: "Music server response timed out. Please try again."
                        }, null, 2)
                    }]
                }
            });
        });

        req.write(postData);
        req.end();
    });
}

// Main processing loop - handles both sync and async responses
function main() {
    process.stdin.setEncoding('utf8');
    
    let inputBuffer = '';
    
    process.stdin.on('data', (chunk) => {
        inputBuffer += chunk;
        
        const lines = inputBuffer.split('\n');
        inputBuffer = lines.pop() || '';
        
        for (const line of lines) {
            if (line.trim()) {
                try {
                    const input = JSON.parse(line.trim());
                    const response = handleRequest(input);
                    
                    // Handle both sync and async responses
                    if (response && typeof response.then === 'function') {
                        // Async response (for music commands)
                        response.then(result => {
                            console.log(JSON.stringify(result));
                        }).catch(error => {
                            console.log(JSON.stringify({
                                jsonrpc: "2.0",
                                id: input.id,
                                error: { code: -32603, message: error.message }
                            }));
                        });
                    } else {
                        // Sync response (for protocol methods)
                        console.log(JSON.stringify(response));
                    }
                } catch (error) {
                    console.log(JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        error: { code: -32603, message: error.message }
                    }));
                }
            }
        }
    });

    process.stdin.on('end', () => process.exit(0));
    process.on('SIGINT', () => process.exit(0));
}

main();
