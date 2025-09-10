/**
 * Chromecast Service with Native Queue Support
 * Uses Google Cast's built-in queue functionality for reliable multi-track playback
 */

const Client = require('castv2-client').Client;
const DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
const { ChromecastError, ServiceUnavailableError } = require('../utils/errors');
const Validator = require('../utils/validator');

class ChromecastServiceQueue {
    constructor(config, logger, connectionManager) {
        this.config = config;
        this.logger = logger || console;
        this.connectionManager = connectionManager;
        
        // Cast client and session
        this.client = null;
        this.player = null;
        this.currentDevice = null;
        this.currentStatus = this._getDefaultStatus();
        this.isAvailable = false;
        
        // Native queue management
        this.queueItems = [];
        this.currentItemId = null;
        this.repeatMode = 'REPEAT_OFF'; // REPEAT_OFF, REPEAT_ALL, REPEAT_SINGLE
        this.shuffle = false;
        
        // Device discovery using chromecast-api
        this.devices = new Map();
        this.client_discovery = null;
        
        this._initialize();
    }

    _getDefaultStatus() {
        return {
            mediaSessionId: null,
            playbackRate: 1,
            playerState: 'IDLE',
            currentTime: 0,
            volume: null,
            media: null,
            currentItemId: null,
            loadingItemId: null,
            preloadedItemId: null,
            repeatMode: 'REPEAT_OFF'
        };
    }

    _initialize() {
        try {
            // Use chromecast-api for device discovery
            const ChromecastAPI = require('chromecast-api');
            this.client_discovery = new ChromecastAPI();
            this.isAvailable = true;
            this._startDeviceDiscovery();
            this.logger.info('Chromecast service with native queue initialized successfully');
        } catch (error) {
            this.logger.warn('Chromecast functionality not available', { error: error.message });
            this.isAvailable = false;
        }
    }

    _startDeviceDiscovery() {
        if (!this.client_discovery) return;
        
        try {
            this.client_discovery.on('device', (device) => {
                this.logger.debug('Chromecast device discovered', { 
                    name: device.name,
                    friendlyName: device.friendlyName,
                    host: device.host
                });
                
                this.devices.set(device.name, {
                    name: device.name,
                    friendlyName: device.friendlyName || device.name,
                    host: device.host,
                    port: 8009 // Standard Chromecast port
                });
            });
            
        } catch (error) {
            this.logger.warn('Failed to start device discovery', { error: error.message });
        }
    }

    async discoverDevices(timeout = 5000) {
        if (!this.isAvailable) {
            throw new ServiceUnavailableError('Chromecast');
        }

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.logger.debug('Discovery completed', { 
                    devicesFound: this.devices.size,
                    timeout 
                });
                resolve(Array.from(this.devices.keys()));
            }, timeout);

            // If we already have devices, resolve immediately
            if (this.devices.size > 0) {
                clearTimeout(timer);
                resolve(Array.from(this.devices.keys()));
            }
        });
    }

    async connectToDevice(deviceName) {
        if (!this.isAvailable) {
            throw new ServiceUnavailableError('Chromecast');
        }

        try {
            Validator.isNonEmptyString(deviceName, 'deviceName');
            this.logger.info('Connecting to Chromecast device with queue support', { deviceName });

            // Find device
            let device = this.devices.get(deviceName);
            if (!device) {
                this.logger.debug('Device not in cache, running discovery...');
                await this.discoverDevices(10000);
                device = this.devices.get(deviceName);
            }

            if (!device) {
                throw new ChromecastError(`Device '${deviceName}' not found after discovery.`);
            }

            // Disconnect existing connection if needed
            if (this.client) {
                await this.disconnect();
            }

            // Create new client connection
            this.client = new Client();
            this.currentDevice = device;

            // Connect to device
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new ChromecastError(`Connection timeout for device '${deviceName}'`));
                }, 15000);

                this.client.connect(device.host, () => {
                    clearTimeout(timeout);
                    this.logger.info('Connected to Chromecast device', { deviceName });
                    resolve();
                });

                this.client.on('error', (err) => {
                    clearTimeout(timeout);
                    reject(new ChromecastError(`Connection failed: ${err.message}`));
                });
            });

            // Launch default media receiver
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new ChromecastError('Failed to launch media receiver'));
                }, 10000);

                this.client.launch(DefaultMediaReceiver, (err, player) => {
                    clearTimeout(timeout);
                    
                    if (err) {
                        reject(new ChromecastError(`Failed to launch receiver: ${err.message}`));
                        return;
                    }

                    this.player = player;
                    this._setupPlayerEventHandlers();
                    
                    this.logger.info('Media receiver launched successfully', { deviceName });
                    resolve();
                });
            });

            // Save connection state
            this.connectionManager.saveConnectionState({ 
                deviceName: device.name, 
                connectedAt: Date.now() 
            });

            return true;

        } catch (error) {
            this.logger.error('Failed to connect to device', { deviceName, error: error.message });
            await this.disconnect();
            if (error instanceof ChromecastError) throw error;
            throw new ChromecastError(`Failed to connect to '${deviceName}': ${error.message}`);
        }
    }

    _setupPlayerEventHandlers() {
        if (!this.player) return;

        // Status updates
        this.player.on('status', (status) => {
            this._handleStatusUpdate(status);
        });

        // Queue change events
        this.player.on('queue-change', (data) => {
            this.logger.info('Queue changed', { 
                currentItemId: data.currentItemId,
                items: data.items?.length || 0
            });
            this._handleQueueChange(data);
        });

        this.player.on('close', () => {
            this.logger.warn('Player connection closed');
            this.player = null;
        });

        this.player.on('error', (err) => {
            this.logger.error('Player error', { error: err.message });
        });
    }

    _handleStatusUpdate(status) {
        this.currentStatus = status;
        
        this.logger.info('Chromecast status update', {
            playerState: status.playerState,
            currentTime: status.currentTime,
            currentItemId: status.currentItemId,
            loadingItemId: status.loadingItemId,
            preloadedItemId: status.preloadedItemId,
            repeatMode: status.repeatMode,
            queueData: status.queueData ? {
                currentItemId: status.queueData.currentItemId,
                startIndex: status.queueData.startIndex,
                items: status.queueData.items?.length || 0
            } : null
        });

        // Update our queue state
        if (status.currentItemId !== this.currentItemId) {
            this.currentItemId = status.currentItemId;
            this.logger.info('Current item changed', { newItemId: this.currentItemId });
            
            // Force visible output for LM Studio debugging
            console.error(`🎵 QUEUE ADVANCE: Current item changed to ${this.currentItemId}`);
            console.error(`🎵 PLAYER STATE: ${status.playerState}`);
        }

        // Save connection state
        try {
            this.connectionManager.saveConnectionState({
                deviceName: this.currentDevice?.name,
                status: this._sanitizeStatus(status),
                lastSeen: Date.now()
            });
        } catch (error) {
            this.logger.error('Failed to save connection state', { error: error.message });
        }
    }

    _handleQueueChange(data) {
        if (data.items) {
            this.queueItems = data.items;
        }
        
        if (data.currentItemId !== undefined) {
            this.currentItemId = data.currentItemId;
        }

        this.logger.info('Queue state updated', {
            itemCount: this.queueItems.length,
            currentItemId: this.currentItemId
        });
    }

    async createQueue(tracks) {
        if (!this.player) {
            throw new ChromecastError('No media player available');
        }

        if (!Array.isArray(tracks) || tracks.length === 0) {
            throw new ChromecastError('Invalid tracks array');
        }

        try {
            this.logger.info('Creating native Chromecast queue', { trackCount: tracks.length });

            // Convert tracks to Cast queue items (DO NOT include itemId - Cast assigns automatically)
            const queueItems = tracks.map((track, index) => {
                return {
                    media: {
                        contentId: track.url,
                        contentType: track.contentType || 'audio/mpeg',
                        streamType: 'BUFFERED',
                        metadata: {
                            type: 0,
                            metadataType: 0,
                            title: track.title || `Track ${index + 1}`,
                            artist: track.artist || 'Unknown Artist',
                            images: track.albumArt ? [{ url: track.albumArt }] : undefined
                        }
                    },
                    autoplay: true,
                    preloadTime: 20 // Preload 20 seconds before track ends
                };
            });

            this.logger.info('Loading queue with correct parameter structure', {
                trackCount: tracks.length,
                firstTrack: tracks[0]?.title,
                repeatMode: this.repeatMode
            });

            const result = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new ChromecastError('Queue load timeout'));
                }, 30000);

                // Use correct queueLoad parameters: items, options, callback
                this.player.queueLoad(queueItems, {
                    startIndex: 0,
                    repeatMode: this.repeatMode,
                    currentTime: 0
                }, (err, status) => {
                    clearTimeout(timeout);
                    
                    if (err) {
                        this.logger.error('Queue load failed with error', { 
                            error: err.message,
                            errorCode: err.code,
                            itemCount: queueItems.length
                        });
                        console.error(`❌ QUEUE LOAD FAILED: ${err.message}`);
                        reject(new ChromecastError(`Failed to load queue: ${err.message}`));
                        return;
                    }

                    this.logger.info('Queue loaded successfully with native Cast functionality', {
                        itemCount: queueItems.length,
                        currentItemId: status?.currentItemId,
                        playerState: status?.playerState,
                        queueData: status?.queueData
                    });
                    
                    // Force visible output for LM Studio debugging
                    console.error(`✅ QUEUE LOADED: ${queueItems.length} tracks, currentItemId: ${status?.currentItemId}`);
                    console.error(`✅ QUEUE STATE: ${status?.playerState}, startIndex: 0`);

                    resolve(status);
                });
            });

            this.queueItems = queueItems;
            this.currentItemId = result?.currentItemId || 1;

            return {
                status: 'success',
                message: `Queue created with ${tracks.length} tracks using native Cast queue`,
                queueSize: tracks.length,
                currentTrack: tracks[0],
                usingNativeQueue: true
            };

        } catch (error) {
            this.logger.error('Failed to create queue', { error: error.message });
            throw new ChromecastError(`Queue creation failed: ${error.message}`);
        }
    }

    async addToQueue(tracks) {
        if (!this.player) {
            throw new ChromecastError('No media player available');
        }

        if (!Array.isArray(tracks)) {
            tracks = [tracks];
        }

        try {
            // Convert tracks to Cast queue items (DO NOT include itemId - Cast assigns automatically)
            const queueItems = tracks.map((track, index) => {
                return {
                    media: {
                        contentId: track.url,
                        contentType: track.contentType || 'audio/mpeg',
                        streamType: 'BUFFERED',
                        metadata: {
                            type: 0,
                            metadataType: 0,
                            title: track.title || `Track ${this.queueItems.length + index + 1}`,
                            artist: track.artist || 'Unknown Artist'
                        }
                    },
                    autoplay: true,
                    preloadTime: 20
                };
            });

            // Insert items into queue
            await new Promise((resolve, reject) => {
                this.player.queueInsert(queueItems, {
                    insertBefore: null // Add to end
                }, (err, status) => {
                    if (err) {
                        reject(new ChromecastError(`Failed to add to queue: ${err.message}`));
                        return;
                    }
                    resolve(status);
                });
            });

            this.queueItems.push(...queueItems);

            this.logger.info('Added tracks to native queue', { 
                added: tracks.length, 
                totalQueueSize: this.queueItems.length 
            });

            return {
                status: 'success',
                message: `Added ${tracks.length} track(s) to native queue`,
                queueSize: this.queueItems.length
            };

        } catch (error) {
            this.logger.error('Failed to add to queue', { error: error.message });
            throw new ChromecastError(`Add to queue failed: ${error.message}`);
        }
    }

    async skipToNext() {
        if (!this.player) {
            throw new ChromecastError('No media player available');
        }

        try {
            await new Promise((resolve, reject) => {
                this.player.queueNext((err, status) => {
                    if (err) {
                        reject(new ChromecastError(`Skip to next failed: ${err.message}`));
                        return;
                    }
                    resolve(status);
                });
            });

            this.logger.info('Skipped to next track using native queue');
            
            return { 
                status: 'success', 
                message: 'Skipped to next track',
                usingNativeQueue: true
            };

        } catch (error) {
            this.logger.error('Failed to skip to next', { error: error.message });
            throw new ChromecastError(`Skip failed: ${error.message}`);
        }
    }

    async skipToPrevious() {
        if (!this.player) {
            throw new ChromecastError('No media player available');
        }

        try {
            await new Promise((resolve, reject) => {
                this.player.queuePrev((err, status) => {
                    if (err) {
                        reject(new ChromecastError(`Skip to previous failed: ${err.message}`));
                        return;
                    }
                    resolve(status);
                });
            });

            this.logger.info('Skipped to previous track using native queue');
            
            return { 
                status: 'success', 
                message: 'Skipped to previous track',
                usingNativeQueue: true
            };

        } catch (error) {
            this.logger.error('Failed to skip to previous', { error: error.message });
            throw new ChromecastError(`Skip to previous failed: ${error.message}`);
        }
    }

    async jumpToItem(itemId) {
        if (!this.player) {
            throw new ChromecastError('No media player available');
        }

        try {
            await new Promise((resolve, reject) => {
                this.player.queueJump(itemId, (err, status) => {
                    if (err) {
                        reject(new ChromecastError(`Jump to item failed: ${err.message}`));
                        return;
                    }
                    resolve(status);
                });
            });

            this.logger.info('Jumped to queue item', { itemId });
            
            return { 
                status: 'success', 
                message: `Jumped to item ${itemId}`,
                usingNativeQueue: true
            };

        } catch (error) {
            this.logger.error('Failed to jump to item', { itemId, error: error.message });
            throw new ChromecastError(`Jump to item failed: ${error.message}`);
        }
    }

    async setRepeatMode(mode) {
        if (!this.player) {
            throw new ChromecastError('No media player available');
        }

        // Convert from our format to Cast format
        const castModes = {
            'none': 'REPEAT_OFF',
            'one': 'REPEAT_SINGLE', 
            'all': 'REPEAT_ALL'
        };

        const castMode = castModes[mode] || mode;

        try {
            await new Promise((resolve, reject) => {
                this.player.queueSetRepeatMode(castMode, (err, status) => {
                    if (err) {
                        reject(new ChromecastError(`Set repeat mode failed: ${err.message}`));
                        return;
                    }
                    resolve(status);
                });
            });

            this.repeatMode = castMode;
            this.logger.info('Set repeat mode', { mode: castMode });
            
            return {
                status: 'success',
                message: `Repeat mode set to: ${mode}`,
                repeatMode: castMode
            };

        } catch (error) {
            this.logger.error('Failed to set repeat mode', { mode, error: error.message });
            throw new ChromecastError(`Set repeat mode failed: ${error.message}`);
        }
    }

    async pause() {
        if (!this.player) {
            throw new ChromecastError('No media player available');
        }

        try {
            await new Promise((resolve, reject) => {
                this.player.pause((err) => {
                    if (err) {
                        reject(new ChromecastError(`Pause failed: ${err.message}`));
                        return;
                    }
                    resolve();
                });
            });

            this.logger.info('Playback paused');
            return { 
                status: 'success', 
                message: 'Playback paused',
                playerState: 'PAUSED'
            };

        } catch (error) {
            this.logger.error('Failed to pause', { error: error.message });
            throw new ChromecastError(`Pause failed: ${error.message}`);
        }
    }

    async resume() {
        if (!this.player) {
            throw new ChromecastError('No media player available');
        }

        try {
            await new Promise((resolve, reject) => {
                this.player.play((err) => {
                    if (err) {
                        reject(new ChromecastError(`Resume failed: ${err.message}`));
                        return;
                    }
                    resolve();
                });
            });

            this.logger.info('Playback resumed');
            return { 
                status: 'success', 
                message: 'Playback resumed',
                playerState: 'PLAYING'
            };

        } catch (error) {
            this.logger.error('Failed to resume', { error: error.message });
            throw new ChromecastError(`Resume failed: ${error.message}`);
        }
    }

    async stop() {
        if (!this.player) {
            throw new ChromecastError('No media player available');
        }

        try {
            await new Promise((resolve, reject) => {
                this.player.stop((err) => {
                    if (err) {
                        reject(new ChromecastError(`Stop failed: ${err.message}`));
                        return;
                    }
                    resolve();
                });
            });

            // Clear queue state
            this.queueItems = [];
            this.currentItemId = null;

            this.logger.info('Playback stopped and queue cleared');
            return { 
                status: 'success', 
                message: 'Playback stopped',
                playerState: 'IDLE'
            };

        } catch (error) {
            this.logger.error('Failed to stop', { error: error.message });
            throw new ChromecastError(`Stop failed: ${error.message}`);
        }
    }

    async setVolume(level) {
        if (!this.player) {
            throw new ChromecastError('No media player available');
        }

        try {
            Validator.isVolume(level);

            await new Promise((resolve, reject) => {
                this.player.setVolume({ level }, (err) => {
                    if (err) {
                        reject(new ChromecastError(`Set volume failed: ${err.message}`));
                        return;
                    }
                    resolve();
                });
            });

            this.logger.info('Volume set', { level });
            return {
                status: 'success',
                message: `Volume set to ${Math.round(level * 100)}%`,
                volume: level
            };

        } catch (error) {
            this.logger.error('Failed to set volume', { level, error: error.message });
            throw new ChromecastError(`Volume control failed: ${error.message}`);
        }
    }

    async seek(position) {
        if (!this.player) {
            throw new ChromecastError('No media player available');
        }

        try {
            await new Promise((resolve, reject) => {
                this.player.seek(position, (err) => {
                    if (err) {
                        reject(new ChromecastError(`Seek failed: ${err.message}`));
                        return;
                    }
                    resolve();
                });
            });

            this.logger.info('Seeked to position', { position });
            return { 
                status: 'success', 
                message: `Seeked to ${position} seconds`,
                position
            };

        } catch (error) {
            this.logger.error('Failed to seek', { position, error: error.message });
            throw new ChromecastError(`Seek failed: ${error.message}`);
        }
    }

    async playMedia(contentId, contentType, title, albumArt) {
        if (!this.player) {
            throw new ChromecastError('No media player available');
        }

        try {
            this.logger.info('Playing single media item', { contentId, contentType, title });

            const mediaInfo = {
                contentId: contentId,
                contentType: contentType || 'audio/mpeg',
                streamType: 'BUFFERED',
                metadata: {
                    type: 0,
                    metadataType: 0,
                    title: title || 'Unknown Track',
                    images: albumArt ? [{ url: albumArt }] : undefined
                }
            };

            const result = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new ChromecastError('Media load timeout'));
                }, 15000);

                this.player.load(mediaInfo, { autoplay: true }, (err, status) => {
                    clearTimeout(timeout);
                    
                    if (err) {
                        this.logger.error('Media load failed', { error: err.message, contentId });
                        reject(new ChromecastError(`Failed to load media: ${err.message}`));
                        return;
                    }

                    this.logger.info('Media loaded successfully', {
                        contentId,
                        playerState: status?.playerState
                    });

                    resolve(status);
                });
            });

            return true;

        } catch (error) {
            this.logger.error('Failed to play media', { contentId, error: error.message });
            throw new ChromecastError(`Media playback failed: ${error.message}`);
        }
    }

    getQueueInfo() {
        const currentItem = this.queueItems.find(item => item.itemId === this.currentItemId);
        
        return {
            status: 'success',
            usingNativeQueue: true,
            queue: this.queueItems.map((item, index) => ({
                position: index + 1,
                itemId: item.itemId,
                title: item.media.metadata.title,
                artist: item.media.metadata.artist,
                url: item.media.contentId,
                current: item.itemId === this.currentItemId
            })),
            queueSize: this.queueItems.length,
            currentItemId: this.currentItemId,
            currentTrack: currentItem ? {
                itemId: currentItem.itemId,
                title: currentItem.media.metadata.title,
                artist: currentItem.media.metadata.artist,
                url: currentItem.media.contentId
            } : null,
            repeatMode: this.repeatMode,
            shuffle: this.shuffle
        };
    }

    getStatus() {
        const baseStatus = {
            connected: !!this.currentDevice && !!this.player,
            deviceName: this.currentDevice?.name || null,
            playing: false,
            playerState: 'DISCONNECTED',
            usingNativeQueue: true,
            queue: {
                size: this.queueItems.length,
                currentItemId: this.currentItemId,
                repeatMode: this.repeatMode,
                shuffle: this.shuffle
            }
        };

        if (this.currentStatus) {
            const sanitizedStatus = this._sanitizeStatus(this.currentStatus);
            
            return {
                ...baseStatus,
                playing: sanitizedStatus.playerState === 'PLAYING',
                playerState: sanitizedStatus.playerState,
                currentTime: sanitizedStatus.currentTime,
                volume: sanitizedStatus.volume?.level,
                muted: sanitizedStatus.volume?.muted || false,
                media: sanitizedStatus.media,
                currentItemId: sanitizedStatus.currentItemId,
                loadingItemId: sanitizedStatus.loadingItemId,
                preloadedItemId: sanitizedStatus.preloadedItemId,
                repeatMode: sanitizedStatus.repeatMode
            };
        }

        return baseStatus;
    }

    _sanitizeStatus(status) {
        if (!status || typeof status !== 'object') {
            return this._getDefaultStatus();
        }

        return {
            mediaSessionId: status.mediaSessionId || null,
            playbackRate: status.playbackRate || 1,
            playerState: status.playerState || 'IDLE',
            currentTime: status.currentTime || 0,
            volume: status.volume || null,
            media: status.media || null,
            currentItemId: status.currentItemId || null,
            loadingItemId: status.loadingItemId || null,
            preloadedItemId: status.preloadedItemId || null,
            repeatMode: status.repeatMode || 'REPEAT_OFF'
        };
    }

    isHealthy() {
        return this.isAvailable && !!this.client && !!this.player;
    }

    async disconnect() {
        try {
            if (this.player) {
                this.player.close();
                this.player = null;
            }

            if (this.client) {
                this.client.close();
                this.client = null;
            }

            // No cleanup needed for chromecast-api discovery

            this.currentDevice = null;
            this.currentStatus = this._getDefaultStatus();
            this.queueItems = [];
            this.currentItemId = null;

            this.logger.info('Disconnected from Chromecast');

        } catch (error) {
            this.logger.error('Error during disconnect', { error: error.message });
        }
    }
}

module.exports = ChromecastServiceQueue;
