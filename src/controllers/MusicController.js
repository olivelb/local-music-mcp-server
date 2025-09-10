/**
 * Music Controller
 * Handles all music-related MCP tool calls
 */

const { ValidationError, NotFoundError } = require('../utils/errors');
const Validator = require('../utils/validator');

class MusicController {
    constructor(databaseService, logger) {
        this.database = databaseService;
        this.logger = logger;
    }

    async searchMusic(params) {
        try {
            const { query, type = 'basic', filter, limit = 10, fuzzy = false, phonetic = false, random = false } = params;
            
            Validator.isValidQuery(query);
            Validator.isValidLimit(limit);

            this.logger.debug('Search music request', { query, type, limit, random });

            const options = {
                limit,
                fuzzy,
                exact: type === 'exact',
                random
            };

            const tracks = this.database.searchTracks(query, options);

            return {
                status: 'success',
                results: tracks,
                count: tracks.length,
                query: query,
                type: type,
                limit: limit,
                random: random
            };

        } catch (error) {
            this.logger.error('Search music failed', { params, error: error.message });
            
            if (error instanceof ValidationError) {
                return { status: 'error', message: error.message };
            }
            
            return { status: 'error', message: 'Search failed' };
        }
    }

    async getLibraryStats() {
        try {
            this.logger.debug('Library stats request');

            const stats = this.database.getLibraryStats();

            return {
                status: 'success',
                stats: {
                    total_tracks: stats.total_tracks,
                    total_artists: stats.total_artists,
                    total_albums: stats.total_albums,
                    total_genres: stats.total_genres,
                    total_duration_hours: stats.total_hours,
                    total_size_gb: stats.total_size_gb
                }
            };

        } catch (error) {
            this.logger.error('Get library stats failed', { error: error.message });
            return { status: 'error', message: 'Failed to get library statistics' };
        }
    }

    async managePlaylist(params) {
        try {
            const { action, playlist_id, name, description } = params;

            this.logger.debug('Manage playlist request', { action, playlist_id, name });

            switch (action) {
                case 'create':
                    Validator.isNonEmptyString(name, 'name');
                    const playlist = this.database.createPlaylist(name, description || '');
                    return {
                        status: 'success',
                        message: `Playlist '${name}' created successfully`,
                        playlist: playlist
                    };

                case 'list':
                    const playlists = this.database.getPlaylists();
                    return {
                        status: 'success',
                        playlists: playlists,
                        count: playlists.length
                    };

                default:
                    return { status: 'error', message: `Unknown playlist action: ${action}` };
            }

        } catch (error) {
            this.logger.error('Manage playlist failed', { params, error: error.message });
            
            if (error instanceof ValidationError) {
                return { status: 'error', message: error.message };
            }
            
            return { status: 'error', message: 'Playlist operation failed' };
        }
    }

    // Additional music-related methods can be added here
    // - addToPlaylist
    // - removeFromPlaylist
    // - updateTrackMetadata
    // - etc.
}

module.exports = MusicController;
