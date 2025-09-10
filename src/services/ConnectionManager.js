/**
 * Connection Manager Service
 * Handles persistent connection state across MCP server restarts
 */

const fs = require('fs');
const path = require('path');

class ConnectionManager {
    constructor(dataDirectory, logger) {
        this.dataDir = dataDirectory;
        this.logger = logger || console;
        
        this.connectionStateFile = path.join(dataDirectory, 'chromecast_connection.json');
        this.statusFile = path.join(dataDirectory, 'chromecast_status.json');
        
        this._ensureDataDirectory();
    }

    _ensureDataDirectory() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    saveConnectionState(state) {
        try {
            const stateToSave = {
                ...state,
                timestamp: Date.now(),
                version: '1.0'
            };

            fs.writeFileSync(
                this.connectionStateFile, 
                JSON.stringify(stateToSave, null, 2)
            );

            this.logger.debug('Connection state saved', { deviceName: state.deviceName });

        } catch (error) {
            this.logger.error('Failed to save connection state', { error: error.message });
        }
    }

    loadConnectionState() {
        try {
            if (!fs.existsSync(this.connectionStateFile)) {
                return null;
            }

            const data = fs.readFileSync(this.connectionStateFile, 'utf8');
            const state = JSON.parse(data);

            // Check if state is not too old (max 1 hour)
            const maxAge = 60 * 60 * 1000; // 1 hour
            if (Date.now() - state.timestamp > maxAge) {
                this.logger.debug('Connection state expired, ignoring');
                return null;
            }

            this.logger.debug('Connection state loaded', { deviceName: state.deviceName });
            return state;

        } catch (error) {
            this.logger.debug('Failed to load connection state', { error: error.message });
            return null;
        }
    }

    saveStatus(status) {
        try {
            const statusToSave = {
                ...status,
                timestamp: Date.now(),
                version: '1.0'
            };

            fs.writeFileSync(
                this.statusFile, 
                JSON.stringify(statusToSave, null, 2)
            );

            this.logger.debug('Status saved');

        } catch (error) {
            this.logger.error('Failed to save status', { error: error.message });
        }
    }

    loadStatus() {
        try {
            if (!fs.existsSync(this.statusFile)) {
                return null;
            }

            const data = fs.readFileSync(this.statusFile, 'utf8');
            const status = JSON.parse(data);

            // Check if status is not too old (max 5 minutes)
            const maxAge = 5 * 60 * 1000; // 5 minutes
            if (Date.now() - status.timestamp > maxAge) {
                this.logger.debug('Status expired, ignoring');
                return null;
            }

            this.logger.debug('Status loaded');
            return status;

        } catch (error) {
            this.logger.debug('Failed to load status', { error: error.message });
            return null;
        }
    }

    updateLastSeen(deviceName) {
        try {
            const state = this.loadConnectionState();
            if (state && state.deviceName === deviceName) {
                state.lastSeen = Date.now();
                this.saveConnectionState(state);
            }
        } catch (error) {
            this.logger.debug('Failed to update last seen', { error: error.message });
        }
    }

    clearConnectionState() {
        try {
            if (fs.existsSync(this.connectionStateFile)) {
                fs.unlinkSync(this.connectionStateFile);
            }
            if (fs.existsSync(this.statusFile)) {
                fs.unlinkSync(this.statusFile);
            }
            this.logger.debug('Connection state cleared');
        } catch (error) {
            this.logger.error('Failed to clear connection state', { error: error.message });
        }
    }
}

module.exports = ConnectionManager;
