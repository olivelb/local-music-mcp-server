/**
 * Chromecast Controller
 * Handles all Chromecast-related MCP tool calls
 */

const { ChromecastError, ServiceUnavailableError, ValidationError } = require('../utils/errors');
const Validator = require('../utils/validator');

class ChromecastController {
    constructor(chromecastService, databaseService, config, logger) {
        this.chromecast = chromecastService;
        this.database = databaseService;
        this.config = config;
        this.logger = logger;
    }

    async listChromecast() {
        try {
            if (!this.chromecast.isAvailable) {
                return { status: 'error', message: 'Chromecast service not available' };
            }

            this.logger.debug('List Chromecast devices request');

            const devices = await this.chromecast.discoverDevices();

            return {
                status: 'success',
                devices: devices,
                count: devices.length
            };

        } catch (error) {
            this.logger.error('List Chromecast failed', { error: error.message });
            
            if (error instanceof ServiceUnavailableError) {
                return { status: 'error', message: error.message };
            }
            
            return { status: 'error', message: 'Failed to discover devices' };
        }
    }

    async connectChromecast(params) {
        try {
            if (!this.chromecast.isAvailable) {
                return { status: 'error', message: 'Chromecast service not available' };
            }

            const { device_name } = params;
            Validator.isNonEmptyString(device_name, 'device_name');

            this.logger.debug('Connect Chromecast request', { device_name });

            const connected = await this.chromecast.connectToDevice(device_name);

            return {
                status: connected ? 'success' : 'error',
                message: connected ? `Connected to ${device_name}` : `Failed to connect to ${device_name}`,
                device_name: device_name
            };

        } catch (error) {
            this.logger.error('Connect Chromecast failed', { params, error: error.message });
            
            if (error instanceof ChromecastError || error instanceof ValidationError) {
                return { status: 'error', message: error.message };
            }
            
            return { status: 'error', message: 'Connection failed' };
        }
    }

    async playTrack(params) {
        try {
            if (!this.chromecast.isAvailable) {
                return { status: 'error', message: 'Chromecast service not available' };
            }

            const { track_id, device_name } = params;
            Validator.isValidTrackId(track_id);

            this.logger.debug('Play track request', { track_id, device_name });

            // Get track from database
            const track = this.database.getTrackById(track_id);

            // Connect to device if specified or if current device differs
            if (device_name && (!this.chromecast.currentDevice || this.chromecast.currentDevice.name !== device_name)) {
                await this.chromecast.connectToDevice(device_name);
            }

            // Ensure we have a connected device
            if (!this.chromecast.currentDevice) {
                return { status: 'error', message: 'No Chromecast device connected' };
            }

            // Build streaming URL
            const streamingUrl = this._buildStreamingUrl(track);
            
            // Determine content type
            const contentType = this._getContentType(track.filepath);

            // Play the track
            const success = await this.chromecast.playMedia(
                streamingUrl,
                contentType,
                track.title || 'Unknown Track'
            );

            return {
                status: success ? 'success' : 'error',
                message: success ? `Playing: ${track.title}` : 'Failed to play track',
                track: {
                    id: track.id,
                    title: track.title,
                    artist: track.artist,
                    album: track.album
                }
            };

        } catch (error) {
            this.logger.error('Play track failed', { params, error: error.message });
            
            if (error instanceof ChromecastError || error instanceof ValidationError) {
                return { status: 'error', message: error.message };
            }
            
            return { status: 'error', message: 'Playback failed' };
        }
    }

    async setVolume(params) {
        try {
            if (!this.chromecast.isAvailable) {
                return { status: 'error', message: 'Chromecast service not available' };
            }

            const { volume } = params;
            Validator.isVolume(volume);

            this.logger.debug('Set volume request', { volume });

            if (!this.chromecast.currentDevice) {
                return { status: 'error', message: 'No Chromecast device connected' };
            }

            const success = await this.chromecast.setVolume(volume);

            return {
                status: success ? 'success' : 'error',
                message: success ? `Volume set to ${Math.round(volume * 100)}%` : 'Failed to set volume',
                volume: volume
            };

        } catch (error) {
            this.logger.error('Set volume failed', { params, error: error.message });
            
            if (error instanceof ChromecastError || error instanceof ValidationError) {
                return { status: 'error', message: error.message };
            }
            
            return { status: 'error', message: 'Volume control failed' };
        }
    }

    async skipToNext() {
        try {
            if (!this.chromecast.isAvailable) {
                return { status: 'error', message: 'Chromecast service not available' };
            }

            this.logger.debug('Skip to next request');

            if (!this.chromecast.currentDevice) {
                return { status: 'error', message: 'No Chromecast device connected' };
            }

            const result = await this.chromecast.skipToNext();
            return result;

        } catch (error) {
            this.logger.error('Skip to next failed', { error: error.message });
            
            if (error instanceof ChromecastError) {
                return { status: 'error', message: error.message };
            }
            
            return { status: 'error', message: 'Skip failed' };
        }
    }

    async getChromecastStatus() {
        try {
            this.logger.debug('Get Chromecast status request');

            const status = this.chromecast.getStatus();

            return {
                status: 'success',
                ...status
            };

        } catch (error) {
            this.logger.error('Get Chromecast status failed', { error: error.message });
            return { status: 'error', message: 'Failed to get status' };
        }
    }

    // New Playback Control Methods
    
    async pausePlayback() {
        try {
            this.logger.debug('Pause playback request');

            const result = await this.chromecast.pause();

            return {
                status: 'success',
                ...result
            };

        } catch (error) {
            this.logger.error('Pause playback failed', { error: error.message });
            return { status: 'error', message: error.message };
        }
    }

    async resumePlayback() {
        try {
            this.logger.debug('Resume playback request');

            const result = await this.chromecast.resume();

            return {
                status: 'success',
                ...result
            };

        } catch (error) {
            this.logger.error('Resume playback failed', { error: error.message });
            return { status: 'error', message: error.message };
        }
    }

    async stopPlayback() {
        try {
            this.logger.debug('Stop playback request');

            const result = await this.chromecast.stop();

            return {
                status: 'success',
                ...result
            };

        } catch (error) {
            this.logger.error('Stop playback failed', { error: error.message });
            return { status: 'error', message: error.message };
        }
    }

    async skipToPrevious() {
        try {
            this.logger.debug('Skip to previous request');

            const result = await this.chromecast.skipToPrevious();

            return {
                status: 'success',
                ...result
            };

        } catch (error) {
            this.logger.error('Skip to previous failed', { error: error.message });
            return { status: 'error', message: error.message };
        }
    }

    async skipToTrack(params) {
        const { track_number } = params;
        
        if (typeof track_number !== 'number' || track_number < 1) {
            return { status: 'error', message: 'Invalid track number. Must be a positive integer starting from 1.' };
        }

        try {
            this.logger.debug('Skip to track request', { track_number });

            const result = await this.chromecast.skipToTrack(track_number);

            return {
                status: 'success',
                ...result
            };

        } catch (error) {
            this.logger.error('Skip to track failed', { track_number, error: error.message });
            return { status: 'error', message: error.message };
        }
    }

    async seekToPosition(params) {
        const { position } = params;
        
        if (typeof position !== 'number' || position < 0) {
            return { status: 'error', message: 'Invalid position parameter' };
        }

        try {
            this.logger.debug('Seek to position request', { position });

            const result = await this.chromecast.seek(position);

            return {
                status: 'success',
                ...result
            };

        } catch (error) {
            this.logger.error('Seek failed', { position, error: error.message });
            return { status: 'error', message: error.message };
        }
    }

    // Queue Management Methods

    async playMultipleTracks(params) {
        const { tracks, shuffle = false, device_name } = params;
        // Support both startIndex (camelCase) and start_index (snake_case)
        const startIndex = (typeof params.startIndex === 'number')
            ? params.startIndex
            : (typeof params.start_index === 'number')
                ? params.start_index
                : 0;
        
        if (!Array.isArray(tracks) || tracks.length === 0) {
            return { status: 'error', message: 'No tracks provided' };
        }

        try {
            this.logger.debug('Play multiple tracks request', { 
                trackCount: tracks.length, 
                shuffle, 
                startIndex 
            });

            // Connect to device if specified or ensure a device is connected
            if (device_name) {
                if (!this.chromecast.currentDevice || this.chromecast.currentDevice.name !== device_name) {
                    await this.chromecast.connectToDevice(device_name);
                }
            } else if (!this.chromecast.currentDevice) {
                return { status: 'error', message: 'No Chromecast device connected. Please specify device_name or connect first.' };
            }

            // Process tracks from database
            const processedTracks = [];
            for (const trackIdentifier of tracks) {
                let track;
                
                if (typeof trackIdentifier === 'object' && trackIdentifier.id) {
                    track = trackIdentifier;
                } else {
                    const trackId = typeof trackIdentifier === 'string' ? 
                        parseInt(trackIdentifier) : trackIdentifier;
                    track = await this.database.getTrackById(trackId);
                }

                if (track) {
                    processedTracks.push({
                        id: track.id,
                        title: track.title || 'Unknown Track',
                        artist: track.artist || 'Unknown Artist',
                        url: this._buildStreamingUrl(track),
                        contentType: this._getContentType(track.filepath),
                        duration: track.duration,
                        trackId: track.id
                    });
                }
            }

            if (processedTracks.length === 0) {
                return { status: 'error', message: 'No valid tracks found' };
            }

            // Try native Cast queue first, fall back to single track if it fails
            try {
                this.logger.info('Attempting native Cast queue for multi-track playback', {
                    trackCount: processedTracks.length,
                    shuffle,
                    startIndex
                });

                // Create native queue with shorter timeout
                const createResult = await Promise.race([
                    this.chromecast.createQueue(processedTracks),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Native queue timeout')), 10000))
                ]);

                // Jump to start index if not 0
                if (startIndex > 0 && startIndex < processedTracks.length) {
                    await this.chromecast.jumpToItem(startIndex + 1);
                }

                return {
                    status: 'success',
                    message: `Created native Cast queue with ${processedTracks.length} tracks`,
                    tracksAdded: processedTracks.length,
                    shuffle,
                    startIndex,
                    usingNativeQueue: true,
                    queueInfo: createResult
                };

            } catch (nativeQueueError) {
                this.logger.warn('Native queue failed, falling back to single track playback', { 
                    error: nativeQueueError.message 
                });

                // Fallback: Play first track using standard load method
                const firstTrack = processedTracks[startIndex] || processedTracks[0];
                
                const playResult = await this.chromecast.playMedia(
                    firstTrack.url,
                    firstTrack.contentType,
                    firstTrack.title
                );

                return {
                    status: 'success',
                    message: `Playing first track: ${firstTrack.title} (Native queue failed, playing single track)`,
                    tracksAdded: 1,
                    totalTracks: processedTracks.length,
                    currentTrack: firstTrack,
                    usingNativeQueue: false,
                    fallbackUsed: true,
                    warning: 'Native queue functionality is not working properly. Only playing first track.'
                };
            }

        } catch (error) {
            this.logger.error('Play multiple tracks failed', { error: error.message });
            return { status: 'error', message: error.message };
        }
    }

    async manageQueue(params) {
        const { action, trackIds, index, mode } = params;

        try {
            this.logger.debug('Manage queue request', { action, trackIds, index, mode });

            switch (action) {
                case 'add':
                    if (!Array.isArray(trackIds) || trackIds.length === 0) {
                        return { status: 'error', message: 'No track IDs provided for add operation' };
                    }

                    const tracksToAdd = [];
                    for (const trackId of trackIds) {
                        const track = await this.database.getTrackById(trackId);
                        if (track) {
                            tracksToAdd.push({
                                id: track.id,
                                title: track.title || 'Unknown Track',
                                artist: track.artist || 'Unknown Artist',
                                url: this._buildStreamingUrl(track),
                                contentType: this._getContentType(track.filepath),
                                duration: track.duration,
                                trackId: track.id
                            });
                        }
                    }

                    return await this.chromecast.addToQueue(tracksToAdd);

                case 'remove':
                    if (typeof index !== 'number') {
                        return { status: 'error', message: 'Index required for remove operation' };
                    }
                    return this.chromecast.removeFromQueue(index);

                case 'clear':
                    return this.chromecast.clearQueue();

                case 'shuffle':
                    return this.chromecast.shuffleQueue();

                case 'restore':
                    return this.chromecast.restoreQueueOrder();

                case 'repeat':
                    if (!mode || !['none', 'one', 'all'].includes(mode)) {
                        return { status: 'error', message: 'Valid repeat mode required (none, one, all)' };
                    }
                    return this.chromecast.setRepeatMode(mode);

                case 'info':
                    return this.chromecast.getQueueInfo();

                default:
                    return { status: 'error', message: 'Invalid queue action' };
            }

        } catch (error) {
            this.logger.error('Manage queue failed', { action, error: error.message });
            return { status: 'error', message: error.message };
        }
    }

    _buildStreamingUrl(track) {
        const baseUrl = this.config.getBaseUrl();
        const ext = this._getFileExtension(track.filepath);
        return `${baseUrl}/stream/${track.id}${ext}`;
    }

    _getFileExtension(filepath) {
        if (!filepath) return '.mp3';
        return require('path').extname(filepath) || '.mp3';
    }

    _getContentType(filepath) {
        const ext = this._getFileExtension(filepath).toLowerCase();
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
}

module.exports = ChromecastController;
