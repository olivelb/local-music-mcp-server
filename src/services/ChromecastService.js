/**
 * Chromecast Service
 * Handles device discovery and playback control with proper error handling and state management
 */

const { ChromecastError, ServiceUnavailableError } = require('../utils/errors');
const Validator = require('../utils/validator');

class ChromecastService {
    constructor(config, logger, connectionManager) {
        this.config = config;
        this.logger = logger || console;
        this.connectionManager = connectionManager;
        
        this.client = null;
        this.devices = new Map();
        this.currentDevice = null;
        this.currentStatus = this._getDefaultStatus();
        this.isAvailable = false;
        
        // Queue management
        this.queue = [];
        this.currentTrackIndex = -1;
        this.shuffle = false;
        this.repeat = 'none'; // 'none', 'one', 'all'
        this.originalQueue = []; // Backup for shuffle mode
        this.isAutoAdvancing = false; // Prevent multiple auto-advancement attempts
        this.sessionWarmupInProgress = false; // Suppress auto-advance during session warmup
        this.preloadInProgress = false; // Prevent multiple preloading attempts
        
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.connectionKeepAlive = null;
        
        this._initialize();
    }

    _getDefaultStatus() {
        return {
            mediaSessionId: null,
            playbackRate: 1,
            playerState: 'IDLE',
            currentTime: 0,
            volume: null,
            media: null
        };
    }

    _initialize() {
        try {
            const ChromecastAPI = require('chromecast-api');
            this.client = new ChromecastAPI();
            this.isAvailable = true;
            
            this._setupEventHandlers();
            this._restorePreviousConnection();
            
            this.logger.info('Chromecast service initialized successfully');
            
        } catch (error) {
            this.logger.warn('Chromecast functionality not available', { error: error.message });
            this.isAvailable = false;
        }
    }

    _setupEventHandlers() {
        if (!this.client) return;

        this.client.on('device', (device) => {
            this.logger.debug('Chromecast device discovered', { name: device.name });
            this.devices.set(device.name, device);

            device.on('status', (status) => {
                this._handleStatusUpdate(device, status);
            });

            // Use the native 'finished' event to handle track completion
            device.on('finished', () => {
                this.logger.info('Track finished - checking for next track', { 
                    queueSize: this.queue.length, 
                    currentIndex: this.currentTrackIndex,
                    device: device.name
                });
                
                if (this.currentDevice && device.name === this.currentDevice.name) {
                    this._handleTrackFinished();
                }
            });

            device.on('disconnect', () => {
                this.logger.warn('Device disconnected', { name: device.name, queueSize: this.queue.length, currentIndex: this.currentTrackIndex });
                if (this.currentDevice && device.name === this.currentDevice.name) {
                    this.currentDevice = null;
                    this.currentStatus = this._getDefaultStatus();
                }
            });

            device.on('error', (error) => {
                this.logger.error('Device error', { name: device.name, error: error.message });
            });
        });
    }

    async _handleTrackFinished() {
        if (this.isAutoAdvancing) {
            this.logger.debug('Track finished but auto-advance already in progress');
            return;
        }

        this.isAutoAdvancing = true;

        try {
            // Handle repeat modes
            if (this.repeat === 'one' && this.currentTrackIndex >= 0) {
                const currentTrack = this.queue[this.currentTrackIndex];
                this.logger.info('Repeating current track', { track: currentTrack.title });
                await this.playMedia(currentTrack.url, currentTrack.contentType, currentTrack.title, true);
                return;
            }

            // Advance to next track
            if (this.queue.length > 0 && this.currentTrackIndex < this.queue.length - 1) {
                this.currentTrackIndex++;
                const nextTrack = this.queue[this.currentTrackIndex];
                
                this.logger.info('Auto-advancing to next track', { 
                    track: nextTrack.title, 
                    index: this.currentTrackIndex,
                    of: this.queue.length
                });
                
                await this.playMedia(nextTrack.url, nextTrack.contentType, nextTrack.title, true);
                return;
            }

            // Handle repeat all
            if (this.repeat === 'all' && this.queue.length > 0) {
                this.currentTrackIndex = 0;
                const firstTrack = this.queue[0];
                this.logger.info('Repeating queue from beginning', { track: firstTrack.title });
                await this.playMedia(firstTrack.url, firstTrack.contentType, firstTrack.title, true);
                return;
            }

            this.logger.info('Queue finished - no more tracks to play');

        } catch (error) {
            this.logger.error('Track auto-advancement failed', { 
                error: error.message,
                queueSize: this.queue.length,
                currentIndex: this.currentTrackIndex
            });
        } finally {
            this.isAutoAdvancing = false;
        }
    }

    _handleStatusUpdate(device, status) {
        if (this.currentDevice && device.name === this.currentDevice.name) {
            // Additional safety check for status object
            if (!status || typeof status !== 'object') {
                this.logger.warn('Invalid status received in _handleStatusUpdate', { 
                    status, 
                    type: typeof status,
                    device: device.name 
                });
                return;
            }

            const previousState = this.currentStatus ? this.currentStatus.playerState : null;
            const previousTime = this.currentStatus ? this.currentStatus.currentTime : 0;
            this.currentStatus = status;
            
            // Enhanced logging for multi-track debugging
            const currentTrack = this.currentTrackIndex >= 0 ? this.queue[this.currentTrackIndex] : null;
            this.logger.info('Status update', { 
                device: device.name, 
                playerState: status ? status.playerState : 'UNKNOWN',
                previousState,
                currentTime: status ? status.currentTime : 0,
                previousTime,
                timeDiff: status && status.currentTime ? (status.currentTime - previousTime).toFixed(2) : 'N/A',
                queueSize: this.queue.length,
                currentTrackIndex: this.currentTrackIndex,
                currentTrackTitle: currentTrack ? currentTrack.title : 'None',
                isAutoAdvancing: this.isAutoAdvancing,
                sessionWarmup: this.sessionWarmupInProgress,
                mediaSessionId: status ? status.mediaSessionId : null,
                repeat: this.repeat,
                shuffle: this.shuffle
            });
            
            // Save connection state with error handling
            try {
                this.connectionManager.saveConnectionState({
                    deviceName: device.name,
                    status: this._sanitizeStatus(status),
                    lastSeen: Date.now()
                });
            } catch (error) {
                this.logger.error('Failed to save connection state', { 
                    error: error.message,
                    device: device.name 
                });
            }

            // Handle auto-advancement when track ends
            if (status && status.playerState) {
                if (this.sessionWarmupInProgress) {
                    this.logger.debug('Suppressing track transition during session warmup', { previousState, currentState: status.playerState });
                } else {
                    this._handleTrackTransition(previousState, status.playerState, status);
                }
            }
        }
    }

    async _handleTrackTransition(previousState, currentState, status) {
        // Check for preemptive track loading opportunity
        let shouldPreload = false;
        if (status && status.media && status.media.duration && status.currentTime !== undefined) {
            const duration = status.media.duration;
            const currentTime = status.currentTime;
            
            // Start preloading next track at 70% through current track (much earlier)
            const preloadThreshold = duration * 0.7; // 70% through the track
            const shouldPreloadNow = duration > 0 && currentTime >= preloadThreshold && 
                                    this.queue.length > 0 && this.currentTrackIndex >= 0 && 
                                    this.currentTrackIndex < this.queue.length - 1 && 
                                    !this.isAutoAdvancing && !this.preloadInProgress;
            
            shouldPreload = shouldPreloadNow;
            
            this.logger.info('Track monitoring', {
                duration,
                currentTime,
                preloadThreshold,
                shouldPreload,
                percentComplete: duration > 0 ? ((currentTime / duration) * 100).toFixed(1) + '%' : 'unknown',
                queueSize: this.queue.length,
                currentIndex: this.currentTrackIndex,
                nextTrackAvailable: this.currentTrackIndex < this.queue.length - 1
            });
        }

        // Traditional state-based detection as backup
        const isStateTransition = previousState === 'PLAYING' && ['IDLE', 'BUFFERING'].includes(currentState);
        const shouldAdvanceTraditional = isStateTransition && this.queue.length > 0 && this.currentTrackIndex >= 0 && !this.isAutoAdvancing;

        // Preemptive loading approach - start loading next track early
        if (shouldPreload) {
            this.preloadInProgress = true;
            this.logger.info('Starting preemptive next track load...', {
                currentTrack: this.queue[this.currentTrackIndex]?.title,
                nextTrack: this.queue[this.currentTrackIndex + 1]?.title,
                timeInTrack: status.currentTime,
                duration: status.media.duration
            });
            
            this._preloadNextTrack();
        }
        
        // Traditional advancement as fallback
        if (shouldAdvanceTraditional) {
            this.isAutoAdvancing = true;
            this.logger.info('Fallback auto-advance triggered (state transition)...', {
                previousState,
                currentState,
                queueSize: this.queue.length,
                currentIndex: this.currentTrackIndex
            });

            this._executeAdvancement();
        }
    }

    async _preloadNextTrack() {
        try {
            const nextIndex = this.currentTrackIndex + 1;
            if (nextIndex >= this.queue.length) {
                this.logger.debug('No next track to preload - at end of queue');
                this.preloadInProgress = false;
                return;
            }

            const nextTrack = this.queue[nextIndex];
            this.logger.info('Preloading next track in background', { 
                track: nextTrack.title, 
                index: nextIndex,
                deviceConnected: !!this.currentDevice 
            });

            // Use a short timeout for preloading to avoid disrupting current playback
            setTimeout(async () => {
                try {
                    if (!this.currentDevice) {
                        this.logger.warn('No device for preload, attempting recovery');
                        await this._attemptDeviceRecovery();
                        if (!this.currentDevice) {
                            this.logger.warn('Preload failed - no device connection');
                            this.preloadInProgress = false;
                            return;
                        }
                    }

                    // Preload the next track by briefly starting it then immediately switching back
                    // This creates the media session for the next track in advance
                    const mediaObject = {
                        url: nextTrack.url,
                        contentType: nextTrack.contentType,
                        metadata: {
                            type: 0,
                            metadataType: 0,
                            title: nextTrack.title + ' (Preload)'
                        }
                    };

                    await new Promise((resolve, reject) => {
                        this.logger.debug('Starting preload media load', { track: nextTrack.title });
                        
                        this.currentDevice.play(mediaObject, 0, (error) => {
                            if (error) {
                                this.logger.debug('Preload failed', { error: error.message, track: nextTrack.title });
                                reject(error);
                                return;
                            }
                            
                            this.logger.debug('Preload media started, preparing for seamless transition', { track: nextTrack.title });
                            
                            // Set up auto-advancement timer to trigger when current track should end
                            this._setupSeamlessTransition(nextTrack, nextIndex);
                            resolve();
                        });
                    });

                } catch (error) {
                    this.logger.error('Preload execution failed', { 
                        track: nextTrack.title, 
                        error: error.message 
                    });
                } finally {
                    this.preloadInProgress = false;
                }
            }, 1000); // Brief delay to avoid interfering with current playback

        } catch (error) {
            this.logger.error('Preload initiation failed', { error: error.message });
            this.preloadInProgress = false;
        }
    }

    async _setupSeamlessTransition(nextTrack, nextIndex) {
        // Wait for the current track to finish naturally, then immediately switch
        const pollInterval = 500; // Check every 0.5 seconds
        
        const checkForTransition = () => {
            if (this.isAutoAdvancing) {
                this.logger.debug('Auto-advance already in progress, canceling seamless transition');
                return;
            }

            // Check if current track is ending soon or has ended
            if (this.currentStatus && this.currentStatus.media && this.currentStatus.media.duration) {
                const duration = this.currentStatus.media.duration;
                const currentTime = this.currentStatus.currentTime || 0;
                const timeRemaining = duration - currentTime;
                
                // If track is very close to end (within 2 seconds) or past end, trigger transition
                if (timeRemaining <= 2 || this.currentStatus.playerState === 'IDLE') {
                    this.logger.info('Seamless transition triggered', {
                        timeRemaining,
                        playerState: this.currentStatus.playerState,
                        nextTrack: nextTrack.title
                    });
                    
                    this.isAutoAdvancing = true;
                    this.currentTrackIndex = nextIndex;
                    
                    // The next track should already be loaded, so we just need to let it play
                    // Check if it's already playing, if not, play it
                    this._verifyAndContinuePlayback(nextTrack, nextIndex);
                    return;
                }
            }

            // Continue monitoring
            if (!this.isAutoAdvancing && this.currentTrackIndex < nextIndex) {
                setTimeout(checkForTransition, pollInterval);
            }
        };

        // Start monitoring
        setTimeout(checkForTransition, pollInterval);
    }

    async _verifyAndContinuePlayback(track, trackIndex) {
        try {
            // Check if we need to restart playback (in case preload didn't work perfectly)
            if (!this.currentStatus || this.currentStatus.playerState !== 'PLAYING') {
                this.logger.info('Restarting playback for seamless transition', { track: track.title });
                await this.playMedia(track.url, track.contentType, track.title, false); // Don't force stop
            }
            
            this.logger.info('Seamless track transition completed', { 
                track: track.title, 
                index: trackIndex,
                queueRemaining: this.queue.length - trackIndex - 1
            });
            
        } catch (error) {
            this.logger.error('Seamless transition verification failed, falling back to recovery', { 
                error: error.message,
                track: track.title
            });
            
            // Fall back to recovery method
            await this._playTrackWithRecovery(track, this.queue, trackIndex);
            
        } finally {
            this.isAutoAdvancing = false;
        }
    }

    async _executeAdvancement() {
        try {
            // Preserve queue state at the start
            const queueBackup = [...this.queue];
            const currentIndex = this.currentTrackIndex;
            
            this.logger.info('Executing advancement', { 
                queueSize: queueBackup.length, 
                currentIndex,
                deviceConnected: !!this.currentDevice 
            });

            // Repeat current track if repeat-one is enabled
            if (this.repeat === 'one' && currentIndex >= 0) {
                const currentTrack = queueBackup[currentIndex];
                this.logger.info('Repeating current track', { track: currentTrack.title });
                await this._playTrackWithRecovery(currentTrack, queueBackup, currentIndex);
                return;
            }

            // Advance to next track in queue
            if (currentIndex < queueBackup.length - 1) {
                const nextIndex = currentIndex + 1;
                const nextTrack = queueBackup[nextIndex];
                this.logger.info('Auto-advancing to next track', { 
                    track: nextTrack.title, 
                    index: nextIndex,
                    of: queueBackup.length
                });
                
                this.currentTrackIndex = nextIndex;
                await this._playTrackWithRecovery(nextTrack, queueBackup, nextIndex);
                return;
            }

            // Repeat entire queue if repeat-all is enabled
            if (this.repeat === 'all' && queueBackup.length > 0) {
                const firstTrack = queueBackup[0];
                this.logger.info('Repeating queue from beginning', { track: firstTrack.title });
                this.currentTrackIndex = 0;
                await this._playTrackWithRecovery(firstTrack, queueBackup, 0);
                return;
            }

            this.logger.info('Queue finished', { queueSize: queueBackup.length });

        } catch (error) {
            this.logger.error('Auto-advancement execution failed', { 
                error: error.message, 
                stack: error.stack,
                queueSize: this.queue.length
            });
        } finally {
            this.isAutoAdvancing = false;
        }
    }

    async _playTrackWithRecovery(track, queueBackup, trackIndex) {
        const maxAttempts = 3;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                this.logger.info(`Playing track attempt ${attempt}`, { 
                    track: track.title, 
                    index: trackIndex,
                    connected: !!this.currentDevice 
                });

                // Ensure we have a connection
                if (!this.currentDevice) {
                    this.logger.warn('No device connection, attempting recovery');
                    await this._attemptDeviceRecovery();
                    
                    if (!this.currentDevice) {
                        // Try to restore queue and reconnect using saved device name
                        const connectionState = this.connectionManager.loadConnectionState();
                        if (connectionState?.deviceName) {
                            this.logger.info('Attempting reconnection with queue recovery', { 
                                device: connectionState.deviceName 
                            });
                            
                            // Restore queue state
                            this.queue = queueBackup;
                            this.currentTrackIndex = trackIndex;
                            
                            await this.connectToDevice(connectionState.deviceName);
                        }
                    }
                }
                
                if (!this.currentDevice) {
                    throw new Error('Unable to establish device connection');
                }

                // Ensure queue is preserved
                this.queue = queueBackup;
                this.currentTrackIndex = trackIndex;

                // Play the track
                await this.playMedia(track.url, track.contentType, track.title, true);
                
                this.logger.info('Track playback successful', { 
                    track: track.title, 
                    attempt,
                    queueSize: this.queue.length
                });
                return; // Success!

            } catch (error) {
                this.logger.error(`Track play attempt ${attempt} failed`, { 
                    track: track.title, 
                    error: error.message,
                    attemptsRemaining: maxAttempts - attempt
                });
                
                if (attempt === maxAttempts) {
                    throw error;
                }
                
                // Brief wait before retry
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }

    _sanitizeStatus(status) {
        // Handle undefined or null status
        if (!status) {
            return {
                mediaSessionId: null,
                playbackRate: 1,
                playerState: 'IDLE',
                currentTime: 0,
                volume: null,
                media: null
            };
        }

        // Additional safety check to ensure status is still valid
        if (typeof status !== 'object') {
            this.logger.warn('Invalid status object received', { status, type: typeof status });
            return {
                mediaSessionId: null,
                playbackRate: 1,
                playerState: 'IDLE',
                currentTime: 0,
                volume: null,
                media: null
            };
        }

        // Safely extract properties with proper null checks
        const safeStatus = {
            mediaSessionId: null,
            playbackRate: 1,
            playerState: 'IDLE',
            currentTime: 0,
            volume: null,
            media: null
        };

        try {
            // Safely extract mediaSessionId
            if (status.mediaSessionId !== undefined && status.mediaSessionId !== null) {
                safeStatus.mediaSessionId = status.mediaSessionId;
            }

            // Safely extract playbackRate
            if (typeof status.playbackRate === 'number') {
                safeStatus.playbackRate = status.playbackRate;
            }

            // Safely extract playerState
            if (typeof status.playerState === 'string') {
                safeStatus.playerState = status.playerState;
            }

            // Safely extract currentTime
            if (typeof status.currentTime === 'number') {
                safeStatus.currentTime = status.currentTime;
            }

            // Safely extract volume
            if (status.volume && typeof status.volume === 'object') {
                safeStatus.volume = {
                    level: typeof status.volume.level === 'number' ? status.volume.level : 
                           typeof status.volume === 'number' ? status.volume : 0,
                    muted: typeof status.volume.muted === 'boolean' ? status.volume.muted : false
                };
            } else if (typeof status.volume === 'number') {
                safeStatus.volume = {
                    level: status.volume,
                    muted: false
                };
            }

            // Safely extract media
            if (status.media && typeof status.media === 'object') {
                safeStatus.media = {
                    contentId: status.media.contentId || null,
                    contentType: status.media.contentType || null,
                    duration: typeof status.media.duration === 'number' ? status.media.duration : null,
                    metadata: null
                };

                if (status.media.metadata && typeof status.media.metadata === 'object') {
                    safeStatus.media.metadata = {
                        title: status.media.metadata.title || null
                    };
                }
            }

        } catch (error) {
            this.logger.warn('Error sanitizing status object', { 
                error: error.message,
                statusKeys: status ? Object.keys(status) : 'null'
            });
        }

        return safeStatus;
    }

    async _restorePreviousConnection() {
        try {
            const connectionState = this.connectionManager.loadConnectionState();
            if (connectionState && connectionState.deviceName) {
                this.logger.info('Attempting to restore previous connection', { 
                    device: connectionState.deviceName 
                });
                
                // Don't await - let it happen in background
                // But add a flag to prevent restoration from overriding active connections
                this.restoringConnection = true;
                this.connectToDevice(connectionState.deviceName).catch(error => {
                    this.logger.debug('Failed to restore connection', { error: error.message });
                }).finally(() => {
                    this.restoringConnection = false;
                });
            }
        } catch (error) {
            this.logger.debug('No previous connection to restore', { error: error.message });
        }
    }

    async discoverDevices(timeout = null) {
        if (!this.isAvailable) {
            throw new ServiceUnavailableError('Chromecast');
        }

        const discoveryTimeout = timeout || this.config.chromecast.discoveryTimeout;
        
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.logger.debug('Discovery completed', { 
                    devicesFound: this.devices.size,
                    timeout: discoveryTimeout 
                });
                resolve(Array.from(this.devices.keys()));
            }, discoveryTimeout);

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
            this.logger.info('Connecting to Chromecast device', { deviceName });

            let device = this.devices.get(deviceName);
            if (!device) {
                this.logger.debug('Device not in cache, running discovery for 10 seconds...');
                await this.discoverDevices(10000); // Increased timeout
                this.logger.debug('Discovery finished. Found devices:', Array.from(this.devices.keys()));
                device = this.devices.get(deviceName);
            }

            if (!device) {
                throw new ChromecastError(`Device '${deviceName}' not found after discovery.`);
            }

            if (this.currentDevice && this.currentDevice.name === device.name) {
                this.logger.info('Already connected to device', { deviceName });
                // Verify connection is still healthy
                try {
                    await new Promise((resolve, reject) => {
                        this.currentDevice.getStatus((err, status) => {
                            if (err) {
                                this.logger.debug('Connection health check failed, will reconnect', { error: err.message });
                                reject(err);
                            } else {
                                this.logger.debug('Connection health check passed');
                                resolve(status);
                            }
                        });
                    });
                    return true; // Connection is healthy
                } catch (error) {
                    this.logger.info('Reconnecting due to unhealthy connection', { error: error.message });
                    // Fall through to reconnect
                }
            }

            // Only disconnect if we're switching to a different device
            if (this.currentDevice && this.currentDevice.name !== device.name) {
                this.logger.warn('Preventing unwanted device switch during connection', { 
                    currentDevice: this.currentDevice.name,
                    requestedDevice: device.name,
                    action: 'maintaining_current_connection'
                });
                // Don't switch if we're already connected to a device and it's working
                return true; // Keep current connection
            } else if (!this.currentDevice) {
                this.disconnect(); // Clean slate
            }
            
            this.currentDevice = device;

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.disconnect();
                    reject(new ChromecastError(`Connection timed out for device '${deviceName}'.`));
                }, 15000); // Increased timeout for session establishment

                // Initialize connection with proper session handling
                const initializeConnection = () => {
                    // First, try to establish a connection by getting status
                    // This will help establish a session if one doesn't exist
                    device.getStatus((err, status) => {
                        if (err) {
                            if (err.message.includes('no session started')) {
                                this.logger.debug('No session error detected, attempting to establish session');
                                // Try to establish session by playing a dummy media briefly
                                const dummyMedia = {
                                    url: 'http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
                                    contentType: 'video/mp4',
                                    metadata: {
                                        type: 0,
                                        metadataType: 0,
                                        title: 'Connection Test'
                                    }
                                };
                                
                                device.play(dummyMedia, 0, (playErr) => {
                                    if (playErr) {
                                        this.logger.debug('Failed to establish session with dummy media, trying direct connection', { error: playErr.message });
                                        attemptDirectConnection();
                                        return;
                                    }
                                    
                                    // Stop the dummy media immediately
                                    setTimeout(() => {
                                        device.stop(() => {
                                            this.logger.debug('Session established successfully');
                                            // Now get status with established session
                                            device.getStatus((statusErr, newStatus) => {
                                                clearTimeout(timeout);
                                                if (statusErr) {
                                                    this.logger.debug('Status check failed after session establishment, but connection should work', { error: statusErr.message });
                                                }
                                                this.logger.info('Successfully connected to device (session established)', { deviceName });
                                                if (newStatus) {
                                                    this._handleStatusUpdate(device, newStatus);
                                                }
                                                this.connectionManager.saveConnectionState({ deviceName: device.name, connectedAt: Date.now() });
                                                this._startKeepAlive();
                                                resolve(true);
                                            });
                                        });
                                    }, 1000);
                                });
                            } else {
                                this.logger.debug('Connection error, trying direct connection', { error: err.message });
                                attemptDirectConnection();
                            }
                        } else {
                            // Status retrieved successfully, connection is good
                            clearTimeout(timeout);
                            this.logger.info('Successfully connected to device with status', { deviceName });
                            this._handleStatusUpdate(device, status);
                            this.connectionManager.saveConnectionState({ deviceName: device.name, connectedAt: Date.now() });
                            this._startKeepAlive();
                            resolve(true);
                        }
                    });
                };

                const attemptDirectConnection = () => {
                    // Fallback: try direct status check (original method)
                    device.getStatus((err, status) => {
                        clearTimeout(timeout);
                        if (err) {
                            // If direct connection also fails, try one more approach
                            if (err.message.includes('no session started')) {
                                this.logger.debug('No session error detected, attempting session recovery');
                                // Wait a bit and try again
                                setTimeout(() => {
                                    device.getStatus((retryErr, retryStatus) => {
                                        if (retryErr) {
                                            this.disconnect();
                                            return reject(new ChromecastError(`Failed to establish connection: ${retryErr.message}`));
                                        }
                                        this.logger.info('Successfully connected to device (retry)', { deviceName });
                                        this._handleStatusUpdate(device, retryStatus);
                                        this.connectionManager.saveConnectionState({ deviceName: device.name, connectedAt: Date.now() });
                                        this._startKeepAlive();
                                        resolve(true);
                                    });
                                }, 2000);
                            } else {
                                this.disconnect();
                                return reject(new ChromecastError(`Failed to get status on connect: ${err.message}`));
                            }
                        } else {
                            this.logger.info('Successfully connected to device (direct)', { deviceName });
                            this._handleStatusUpdate(device, status);
                            this.connectionManager.saveConnectionState({ deviceName: device.name, connectedAt: Date.now() });
                            this._startKeepAlive();
                            resolve(true);
                        }
                    });
                };

                // Start the connection process
                initializeConnection();
            });

            return true;

        } catch (error) {
            this.logger.error('Failed to connect to device', { deviceName, error: error.message });
            this.disconnect();
            if (error instanceof ChromecastError) throw error;
            throw new ChromecastError(`Failed to connect to '${deviceName}': ${error.message}`);
        }
    }

    async playMedia(contentUrl, contentType = 'audio/mpeg', title = 'Unknown Track', forceStop = true) {
        if (!this.currentDevice) {
            throw new ChromecastError('No device connected');
        }

        try {
            this.logger.info('Playing media', { 
                url: contentUrl, 
                type: contentType, 
                title,
                forceStop
            });

            // Ensure a media session is active before sending STOP/PLAY to avoid castv2 client crashes
            await this._ensureSessionActive();

            // Only stop current playback if explicitly requested (default true for user actions)
            if (forceStop) {
                await this._stopCurrentPlayback();
            }

            const result = await this._playMediaDirectly(contentUrl, contentType, title);
            return result.success || true;

        } catch (error) {
            this.logger.error('Failed to play media', { 
                url: contentUrl, 
                error: error.message 
            });
            
            if (error instanceof ChromecastError) throw error;
            throw new ChromecastError(`Media playback failed: ${error.message}`);
        }
    }

    async _playMediaDirectly(contentUrl, contentType = 'audio/mpeg', title = 'Unknown Track') {
        if (!this.currentDevice) {
            throw new ChromecastError('No device connected');
        }

        const mediaObject = {
            url: contentUrl,
            contentType: contentType,
            metadata: {
                type: 0,
                metadataType: 0,
                title: title
            }
        };

        // Play new media
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new ChromecastError('Media load timeout'));
            }, 10000);

            try {
                this.currentDevice.play(mediaObject, 0, (error) => {
                    clearTimeout(timeout);
                    if (error) {
                        reject(new ChromecastError(`Failed to play media: ${error.message}`));
                    } else {
                        resolve();
                    }
                });
            } catch (e) {
                clearTimeout(timeout);
                // Guard against synchronous crashes inside castv2 client when no session exists
                reject(new ChromecastError(`Failed to play media: ${e.message}`));
            }
        });

        // Wait for playback verification
        const isPlaying = await this._verifyPlayback();
        
        if (!isPlaying) {
            throw new ChromecastError('Playback verification failed');
        }

        this.logger.info('Media playback started successfully', { title });
        
        return {
            success: true,
            message: `Playing: ${title}`,
            media: {
                title,
                url: contentUrl,
                contentType
            }
        };
    }

    async _stopCurrentPlayback() {
        if (!this.currentDevice) return;

        return new Promise((resolve) => {
            try {
                this.currentDevice.stop(() => {
                    this.logger.debug('Stopped current playback');
                    resolve();
                });
            } catch (e) {
                // If no media session exists, castv2 client may throw synchronously
                this.logger.debug('Stop requested without active media session', { error: e.message });
                resolve();
            }
        });
    }

    async _verifyPlayback() {
        // Poll device status rather than relying solely on event timing
        const interval = 250; // ms
        const timeout = Math.max(3000, Number(this.config?.chromecast?.verificationTimeout) || 5000);
        const start = Date.now();

        // Small initial delay to allow device to start load
        await new Promise(res => setTimeout(res, interval));

        while (Date.now() - start < timeout) {
            // If we already have a PLAYING state from event, accept
            if (this.currentStatus && (this.currentStatus.playerState === 'PLAYING' || this.currentStatus.playerState === 'BUFFERING')) {
                this.logger.debug('Playback verification successful (from cached status)', { state: this.currentStatus.playerState });
                return true;
            }

            // Poll the device directly
            const polled = await new Promise((resolve) => {
                try {
                    this.currentDevice.getStatus((err, status) => {
                        if (err) {
                            this.logger.debug('verifyPlayback: getStatus error', { error: err.message });
                            return resolve(null);
                        }
                        resolve(status || null);
                    });
                } catch (e) {
                    this.logger.debug('verifyPlayback: getStatus threw', { error: e.message });
                    resolve(null);
                }
            });

            if (polled && typeof polled === 'object') {
                // Update our cached status safely
                this._handleStatusUpdate(this.currentDevice, polled);

                const state = polled.playerState;
                if (state === 'PLAYING' || state === 'BUFFERING') {
                    this.logger.debug('Playback verification successful (via polling)', { state });
                    return true;
                }
            }

            await new Promise(res => setTimeout(res, interval));
        }

        this.logger.warn('Playback verification failed or timed out');
        return false;
    }

    async setVolume(level) {
        if (!this.currentDevice) {
            throw new ChromecastError('No device connected');
        }

        try {
            Validator.isVolume(level);

            await new Promise((resolve, reject) => {
                this.currentDevice.setVolume(level, (error) => {
                    if (error) {
                        reject(new ChromecastError(`Failed to set volume: ${error.message}`));
                    } else {
                        this.logger.info('Volume set successfully', { level });
                        resolve();
                    }
                });
            });

            // Update cached status with new volume immediately
            if (this.currentStatus) {
                this.currentStatus.volume = level;
                this.logger.debug('Updated cached volume status', { newVolume: level });
            }

            // Request fresh status from device to ensure sync
            this._requestStatusUpdate();

            return true;

        } catch (error) {
            this.logger.error('Failed to set volume', { level, error: error.message });
            if (error instanceof ChromecastError) throw error;
            throw new ChromecastError(`Volume control failed: ${error.message}`);
        }
    }

    // Ensure a cast media session is active to avoid mediaSessionId read crashes in castv2-client
    async _ensureSessionActive() {
        if (!this.currentDevice) {
            throw new ChromecastError('No device connected');
        }

        // Try to get current status; if session is not started, attempt to establish one
        const device = this.currentDevice;

        const hasSession = await new Promise((resolve) => {
            try {
                device.getStatus((err, status) => {
                    if (err) {
                        const msg = err.message || '';
                        this.logger.debug('ensureSessionActive: getStatus error', { error: msg });
                        if (msg.includes('no session started')) {
                            return resolve(false);
                        }
                        // Non-session errors: assume we can proceed; play will surface real errors
                        return resolve(true);
                    }
                    // If we got a status object, proceed
                    resolve(!!status);
                });
            } catch (e) {
                this.logger.debug('ensureSessionActive: getStatus threw', { error: e.message });
                resolve(false);
            }
        });

        if (hasSession) return true;

        this.logger.debug('No active session detected, attempting to establish session');

        // Attempt to establish a session by briefly loading dummy media then stopping it
        const dummyMedia = {
            url: 'http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
            contentType: 'video/mp4',
            metadata: {
                type: 0,
                metadataType: 0,
                title: 'Session Warmup'
            }
        };

        const established = await new Promise((resolve) => {
            try {
                this.sessionWarmupInProgress = true;
                device.play(dummyMedia, 0, (playErr) => {
                    if (playErr) {
                        this.logger.debug('ensureSessionActive: failed to start dummy media', { error: playErr.message });
                        this.sessionWarmupInProgress = false;
                        return resolve(false);
                    }
                    // Stop quickly to avoid audible playback
                    setTimeout(() => {
                        try {
                            device.stop(() => {
                                // Re-check status after stop
                                device.getStatus((statusErr) => {
                                    if (statusErr) {
                                        this.logger.debug('ensureSessionActive: status check after warmup failed', { error: statusErr.message });
                                    }
                                    this.logger.debug('Session warmup complete');
                                    this.sessionWarmupInProgress = false;
                                    resolve(true);
                                });
                            });
                        } catch (stopErr) {
                            this.logger.debug('ensureSessionActive: stop threw', { error: stopErr.message });
                            this.sessionWarmupInProgress = false;
                            resolve(true); // Session likely established even if stop threw
                        }
                    }, 800);
                });
            } catch (e) {
                this.logger.debug('ensureSessionActive: play threw', { error: e.message });
                this.sessionWarmupInProgress = false;
                resolve(false);
            }
        });

        return established;
    }

    _requestStatusUpdate() {
        // Request a status update from the device to refresh cached status
        if (this.currentDevice && this.currentDevice.getStatus) {
            try {
                this.currentDevice.getStatus((err, status) => {
                    if (err) {
                        this.logger.debug('Status update request returned error', { error: err.message });
                        return;
                    }
                    if (status) {
                        this._handleStatusUpdate(this.currentDevice, status);
                        this.logger.debug('Requested status update completed');
                    } else {
                        this.logger.debug('Status update returned null/undefined status');
                    }
                });
            } catch (error) {
                this.logger.debug('Status update request failed', { error: error.message });
            }
        }
    }

    async skipToNext() {
        if (!this.currentDevice) {
            throw new ChromecastError('No device connected');
        }

        try {
            if (this.queue && this.queue.length > 0 && this.currentTrackIndex < this.queue.length - 1) {
                // Skip to next track in queue
                this.currentTrackIndex++;
                const nextTrack = this.queue[this.currentTrackIndex];
                await this.playMedia(nextTrack.url, nextTrack.contentType, nextTrack.title, true); // Force stop for user action
                
                this.logger.info('Skipped to next track', { 
                    track: nextTrack.title,
                    index: this.currentTrackIndex,
                    remaining: this.queue.length - this.currentTrackIndex - 1
                });
                
                return { 
                    status: 'success', 
                    message: `Skipped to: ${nextTrack.title}`,
                    currentTrack: nextTrack,
                    queuePosition: this.currentTrackIndex + 1,
                    queueLength: this.queue.length
                };
            } else {
                // No queue or end of queue - try to skip current media
                const player = this.currentDevice.player;
                if (player && this.currentStatus?.playerState === 'PLAYING') {
                    await player.stop();
                    this.logger.info('Stopped current track (no next track available)');
                    return { 
                        status: 'success', 
                        message: 'Stopped current track - no next track in queue'
                    };
                } else {
                    return { 
                        status: 'info', 
                        message: 'No next track available and nothing currently playing'
                    };
                }
            }

        } catch (error) {
            this.logger.error('Failed to skip to next', { error: error.message });
            throw new ChromecastError(`Skip failed: ${error.message}`);
        }
    }

    async pause() {
        if (!this.currentDevice) {
            throw new ChromecastError('No device connected');
        }

        try {
            const player = this.currentDevice.player;
            if (!player) {
                throw new ChromecastError('Player not initialized');
            }

            await player.pause();
            this.logger.info('Playback paused');
            
            // Update cached status immediately
            if (this.currentStatus) {
                this.currentStatus.playerState = 'PAUSED';
                this.logger.debug('Updated cached player state to PAUSED');
            }
            
            // Request fresh status to ensure sync
            this._requestStatusUpdate();
            
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
        if (!this.currentDevice) {
            throw new ChromecastError('No device connected');
        }

        try {
            const player = this.currentDevice.player;
            if (!player) {
                throw new ChromecastError('Player not initialized');
            }

            await player.play();
            this.logger.info('Playback resumed');
            
            // Update cached status immediately
            if (this.currentStatus) {
                this.currentStatus.playerState = 'PLAYING';
                this.logger.debug('Updated cached player state to PLAYING');
            }
            
            // Request fresh status to ensure sync
            this._requestStatusUpdate();
            
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
        if (!this.currentDevice) {
            throw new ChromecastError('No device connected');
        }

        try {
            const player = this.currentDevice.player;
            if (!player) {
                throw new ChromecastError('Player not initialized');
            }

            await player.stop();
            this.logger.info('Playback stopped');
            
            // Update cached status immediately
            if (this.currentStatus) {
                this.currentStatus.playerState = 'IDLE';
                this.currentStatus.currentTime = 0;
                this.currentStatus.media = null;
                this.logger.debug('Updated cached status - playback stopped');
            }
            
            // Clear current track info
            this.currentTrackIndex = -1;
            
            // Request fresh status to ensure sync
            this._requestStatusUpdate();
            
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

    async skipToPrevious() {
        if (!this.currentDevice) {
            throw new ChromecastError('No device connected');
        }

        try {
            if (this.queue && this.queue.length > 0 && this.currentTrackIndex > 0) {
                // Skip to previous track in queue
                this.currentTrackIndex--;
                const prevTrack = this.queue[this.currentTrackIndex];
                await this.playMedia(prevTrack.url, prevTrack.contentType, prevTrack.title, true); // Force stop for user action
                
                this.logger.info('Skipped to previous track', { 
                    track: prevTrack.title,
                    index: this.currentTrackIndex
                });
                
                return { 
                    status: 'success', 
                    message: `Skipped to: ${prevTrack.title}`,
                    currentTrack: prevTrack,
                    queuePosition: this.currentTrackIndex + 1,
                    queueLength: this.queue.length
                };
            } else {
                return { 
                    status: 'info', 
                    message: 'No previous track available'
                };
            }

        } catch (error) {
            this.logger.error('Failed to skip to previous', { error: error.message });
            throw new ChromecastError(`Skip to previous failed: ${error.message}`);
        }
    }

    async skipToTrack(trackNumber) {
        if (!this.currentDevice) {
            throw new ChromecastError('No device connected');
        }

        // Convert to 0-based index
        const targetIndex = trackNumber - 1;

        if (this.queue.length === 0) {
            throw new ChromecastError('Queue is empty');
        }

        if (targetIndex < 0 || targetIndex >= this.queue.length) {
            throw new ChromecastError(`Invalid track number. Valid range: 1-${this.queue.length}`);
        }

        try {
            this.currentTrackIndex = targetIndex;
            const track = this.queue[this.currentTrackIndex];
            
            await this.playMedia(track.url, track.contentType, track.title, true); // Force stop for user action
            
            this.logger.info('Skipped to track number', { 
                trackNumber,
                track: track.title,
                index: this.currentTrackIndex
            });
            
            return { 
                status: 'success', 
                message: `Skipped to track ${trackNumber}: ${track.title}`,
                currentTrack: track,
                queuePosition: this.currentTrackIndex + 1,
                queueLength: this.queue.length,
                trackNumber
            };

        } catch (error) {
            this.logger.error('Failed to skip to track', { trackNumber, error: error.message });
            throw new ChromecastError(`Skip to track failed: ${error.message}`);
        }
    }

    async seek(position) {
        if (!this.currentDevice) {
            throw new ChromecastError('No device connected');
        }

        try {
            const player = this.currentDevice.player;
            if (!player) {
                throw new ChromecastError('Player not initialized');
            }

            await player.seek(position);
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

    // Queue Management Methods
    
    async addToQueue(tracks) {
        if (!this.currentDevice) {
            throw new ChromecastError('No device connected');
        }

        if (!Array.isArray(tracks)) {
            tracks = [tracks];
        }

        try {
            this.logger.info('Adding tracks to queue using Cast Queue API', { trackCount: tracks.length });

            // Convert tracks to Cast QueueItems format
            const queueItems = tracks.map((track, index) => ({
                media: {
                    contentId: track.url,
                    contentType: track.contentType || 'audio/mpeg',
                    metadata: {
                        type: 0,
                        metadataType: 0,
                        title: track.title || track.name || 'Unknown Track',
                        artist: track.artist || 'Unknown Artist'
                    }
                },
                autoplay: true,
                preloadTime: 20, // Preload next track 20 seconds before current ends
                customData: {
                    trackId: track.id || track.trackId,
                    originalIndex: index
                }
            }));

            return new Promise((resolve, reject) => {
                // Use Cast's native queueLoad for proper queue management
                this.currentDevice.queueLoad(queueItems, {
                    startIndex: 0,
                    repeatMode: this._getCastRepeatMode(),
                    shuffle: this.shuffled || false
                }, (error) => {
                    if (error) {
                        this.logger.error('Cast queue load failed, using fallback', { error: error.message });
                        // Fallback to legacy method if Cast queue fails
                        this._fallbackToLegacyQueue(tracks, resolve, reject);
                        return;
                    }

                    // Update internal state
                    this.queue = tracks.map(track => ({
                        url: track.url,
                        title: track.title || track.name || 'Unknown Track',
                        artist: track.artist || 'Unknown Artist',
                        contentType: track.contentType || 'audio/mpeg',
                        trackId: track.id || track.trackId,
                        duration: track.duration
                    }));
                    
                    this.currentTrackIndex = 0;
                    
                    this.logger.info('Cast queue loaded successfully', { 
                        trackCount: tracks.length,
                        firstTrack: tracks[0]?.title || tracks[0]?.name
                    });

                    resolve({
                        status: 'success',
                        message: `Added ${tracks.length} tracks to Cast queue`,
                        queueSize: tracks.length,
                        usingCastQueue: true,
                        queue: this.queue.map((track, index) => ({
                            position: index + 1,
                            title: track.title,
                            artist: track.artist
                        }))
                    });
                });
            });

        } catch (error) {
            this.logger.error('Add to queue failed', { error: error.message });
            throw new ChromecastError('Failed to add tracks to queue', error);
        }
    }

    async playQueue(startIndex = 0) {
        if (!this.currentDevice || this.queue.length === 0) {
            throw new ChromecastError('No device connected or empty queue');
        }

        if (startIndex < 0 || startIndex >= this.queue.length) {
            throw new ChromecastError('Invalid start index');
        }

        try {
            this.logger.info('Starting queue playback', { startIndex, queueSize: this.queue.length });

            // Try Cast queue jump first for non-zero start index
            if (startIndex > 0) {
                return new Promise((resolve, reject) => {
                    this.currentDevice.queueJumpToItem(startIndex, (error) => {
                        if (error) {
                            this.logger.warn('Cast queue jump failed, using legacy playback', { error: error.message });
                            // Fallback to legacy single track play
                            this._playLegacyQueueTrack(startIndex, resolve, reject);
                            return;
                        }

                        this.currentTrackIndex = startIndex;
                        this.logger.info('Cast queue jumped to track', { startIndex });
                        
                        resolve({
                            status: 'success',
                            message: `Playing from track ${startIndex + 1}`,
                            currentTrack: this.queue[startIndex],
                            queuePosition: this.currentTrackIndex + 1,
                            queueLength: this.queue.length,
                            usingCastQueue: true
                        });
                    });
                });
            }

            // For startIndex 0, Cast queue should auto-play
            await this._ensureSessionActive();
            this.currentTrackIndex = 0;
            
            return {
                status: 'success',
                message: 'Cast queue playback started',
                currentTrack: this.queue[0],
                queuePosition: this.currentTrackIndex + 1,
                queueLength: this.queue.length,
                usingCastQueue: true
            };

        } catch (error) {
            this.logger.error('Play queue failed', { error: error.message });
            throw new ChromecastError('Failed to start queue playback', error);
        }
    }

    clearQueue() {
        this.queue = [];
        this.currentTrackIndex = -1;
        this.originalQueue = [];

        this.logger.info('Queue cleared');

        return {
            status: 'success',
            message: 'Queue cleared',
            queueSize: 0
        };
    }

    _fallbackToLegacyQueue(tracks, resolve, reject) {
        try {
            // Legacy queue for devices that don't support Cast queues
            this.queue = tracks.map(track => ({
                url: track.url,
                title: track.title || track.name || 'Unknown Track',
                artist: track.artist || 'Unknown Artist',
                contentType: track.contentType || 'audio/mpeg',
                trackId: track.id || track.trackId,
                duration: track.duration
            }));

            this.currentTrackIndex = 0;
            this.logger.warn('Using legacy queue fallback');

            resolve({
                status: 'success',
                message: `Added ${tracks.length} tracks to legacy queue`,
                queueSize: tracks.length,
                usingCastQueue: false,
                queue: this.queue.map((track, index) => ({
                    position: index + 1,
                    title: track.title,
                    artist: track.artist
                }))
            });
        } catch (error) {
            reject(new ChromecastError('Legacy queue fallback failed', error));
        }
    }

    _getCastRepeatMode() {
        switch (this.repeat) {
            case 'one': return 'REPEAT_SINGLE';
            case 'all': return 'REPEAT_ALL';
            default: return 'REPEAT_OFF';
        }
    }

    async _playLegacyQueueTrack(startIndex, resolve, reject) {
        try {
            this.currentTrackIndex = startIndex;
            const track = this.queue[startIndex];
            
            await this.playMedia(track.url, track.contentType, track.title, true);
            
            resolve({
                status: 'success',
                message: `Playing from track ${startIndex + 1} (legacy mode)`,
                currentTrack: track,
                queuePosition: this.currentTrackIndex + 1,
                queueLength: this.queue.length,
                usingCastQueue: false
            });

        } catch (error) {
            reject(new ChromecastError(`Legacy track playback failed: ${error.message}`));
        }
    }

    removeFromQueue(index) {
        if (index < 0 || index >= this.queue.length) {
            throw new ChromecastError('Invalid queue index');
        }

        const removedTrack = this.queue.splice(index, 1)[0];
        
        // Adjust current track index if necessary
        if (this.currentTrackIndex >= index) {
            this.currentTrackIndex = Math.max(-1, this.currentTrackIndex - 1);
        }

        this.logger.info('Removed track from queue', { 
            track: removedTrack.title,
            index,
            newQueueSize: this.queue.length 
        });

        return {
            status: 'success',
            message: `Removed "${removedTrack.title}" from queue`,
            removedTrack: removedTrack,
            queueSize: this.queue.length
        };
    }

    shuffleQueue() {
        if (this.queue.length <= 1) {
            return {
                status: 'info',
                message: 'Not enough tracks to shuffle'
            };
        }

        // Save original order if not shuffled yet
        if (!this.shuffle) {
            this.originalQueue = [...this.queue];
        }

        // Fisher-Yates shuffle
        for (let i = this.queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
        }

        this.shuffle = true;
        this.currentTrackIndex = -1; // Reset position after shuffle

        this.logger.info('Queue shuffled', { queueSize: this.queue.length });

        return {
            status: 'success',
            message: 'Queue shuffled',
            shuffled: true,
            queueSize: this.queue.length
        };
    }

    restoreQueueOrder() {
        if (!this.shuffle || this.originalQueue.length === 0) {
            return {
                status: 'info',
                message: 'Queue was not shuffled'
            };
        }

        this.queue = [...this.originalQueue];
        this.shuffle = false;
        this.currentTrackIndex = -1; // Reset position

        this.logger.info('Queue order restored');

        return {
            status: 'success',
            message: 'Original queue order restored',
            shuffled: false,
            queueSize: this.queue.length
        };
    }

    setRepeatMode(mode) {
        const validModes = ['none', 'one', 'all'];
        if (!validModes.includes(mode)) {
            throw new ChromecastError(`Invalid repeat mode. Valid modes: ${validModes.join(', ')}`);
        }

        this.repeat = mode;
        this.logger.info('Repeat mode changed', { mode });

        return {
            status: 'success',
            message: `Repeat mode set to: ${mode}`,
            repeatMode: this.repeat
        };
    }

    getQueueInfo() {
        return {
            status: 'success',
            queue: this.queue.map((track, index) => ({
                position: index + 1,
                title: track.title,
                artist: track.artist,
                duration: track.duration,
                current: index === this.currentTrackIndex
            })),
            queueSize: this.queue.length,
            currentTrackIndex: this.currentTrackIndex,
            currentTrack: this.currentTrackIndex >= 0 ? this.queue[this.currentTrackIndex] : null,
            shuffle: this.shuffle,
            repeat: this.repeat
        };
    }

    getStatus() {
        // Preserve queue information even when disconnected for debugging
        const savedQueue = this.queue || [];
        const savedCurrentIndex = this.currentTrackIndex !== undefined ? this.currentTrackIndex : -1;
        
        const baseStatus = {
            connected: !!this.currentDevice,
            deviceName: this.currentDevice?.name || null,
            playing: false,
            playerState: this.currentDevice ? 'IDLE' : 'DISCONNECTED',
            queue: {
                size: savedQueue.length,
                currentIndex: savedCurrentIndex,
                currentTrack: savedCurrentIndex >= 0 && savedCurrentIndex < savedQueue.length ? savedQueue[savedCurrentIndex] : null,
                shuffle: this.shuffle || false,
                repeat: this.repeat || 'none'
            }
        };

        if (this.currentStatus) {
            const sanitizedStatus = this._sanitizeStatus(this.currentStatus);
            
            return {
                ...baseStatus,
                playing: sanitizedStatus.playerState === 'PLAYING',
                playerState: sanitizedStatus.playerState,
                currentTime: sanitizedStatus.currentTime,
                volume: sanitizedStatus.volume ? sanitizedStatus.volume.level : null,
                muted: sanitizedStatus.volume ? sanitizedStatus.volume.muted : false,
                media: sanitizedStatus.media
            };
        }

        return baseStatus;
    }

    _startKeepAlive() {
        if (this.connectionKeepAlive) {
            clearInterval(this.connectionKeepAlive);
        }

        this.connectionKeepAlive = setInterval(() => {
            if (this.currentDevice) {
                // The getStatus from the underlying client library pings the device
                this.currentDevice.getStatus(() => {});
                this.logger.debug('Sent keep-alive ping to device', { device: this.currentDevice.name });
            }
        }, 30000); // Ping every 30 seconds
    }

    // Recovery methods for better multi-track reliability

    async _attemptQueueRecovery(deviceName) {
        this.logger.info('Attempting queue recovery', { device: deviceName, queueSize: this.queue.length });
        
        try {
            // Try to reconnect to the device
            const reconnected = await this.connectToDevice(deviceName);
            if (reconnected && this.queue.length > 0) {
                // Continue from the next track
                if (this.currentTrackIndex < this.queue.length - 1) {
                    this.currentTrackIndex++;
                    const nextTrack = this.queue[this.currentTrackIndex];
                    this.logger.info('Queue recovery: playing next track', { track: nextTrack.title, index: this.currentTrackIndex });
                    await this.playMedia(nextTrack.url, nextTrack.contentType, nextTrack.title, true);
                }
            }
        } catch (error) {
            this.logger.error('Queue recovery failed', { error: error.message });
            // Clear queue if recovery fails completely
            this.queue = [];
            this.currentTrackIndex = -1;
        }
    }

    async _attemptDeviceRecovery() {
        this.logger.info('Attempting device recovery for auto-advance');
        
        if (this.currentDevice && this.currentDevice.name) {
            try {
                // Try to reconnect to current device
                await this.connectToDevice(this.currentDevice.name);
                return !!this.currentDevice;
            } catch (error) {
                this.logger.warn('Device recovery failed', { error: error.message });
            }
        }
        
        // Try to restore from saved connection state
        try {
            const connectionState = this.connectionManager.loadConnectionState();
            if (connectionState && connectionState.deviceName) {
                await this.connectToDevice(connectionState.deviceName);
                return !!this.currentDevice;
            }
        } catch (error) {
            this.logger.warn('Connection state recovery failed', { error: error.message });
        }
        
        return false;
    }

    async _playMediaWithRetry(contentUrl, contentType, title, maxRetries = 2) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    this.logger.info(`Retry attempt ${attempt} for playing media`, { title });
                    // Ensure device is connected before retry
                    if (!this.currentDevice) {
                        await this._attemptDeviceRecovery();
                    }
                    if (!this.currentDevice) {
                        throw new ChromecastError('No device available for retry');
                    }
                }

                await this.playMedia(contentUrl, contentType, title, false);
                return; // Success
                
            } catch (error) {
                this.logger.error(`Play media attempt ${attempt + 1} failed`, { 
                    title, 
                    error: error.message,
                    attemptsRemaining: maxRetries - attempt
                });
                
                if (attempt === maxRetries) {
                    throw error; // Final attempt failed
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
    }

    // Health check
    isHealthy() {
        return this.isAvailable && this.client !== null;
    }

    // Cleanup
    disconnect() {
        if (this.connectionKeepAlive) {
            clearInterval(this.connectionKeepAlive);
            this.connectionKeepAlive = null;
        }
        if (this.currentDevice) {
            this.logger.info('Disconnecting from Chromecast device', { name: this.currentDevice.name });
            // We don't need to call device.close() as the library handles this.
            this.currentDevice = null;
            this.currentStatus = this._getDefaultStatus();
        }
    }
}

module.exports = ChromecastService;
