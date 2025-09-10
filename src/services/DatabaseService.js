/**
 * Database Service
 * Handles all database operations with proper connection management and error handling
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { DatabaseError, NotFoundError } = require('../utils/errors');
const Validator = require('../utils/validator');

class DatabaseService {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger || console;
        this.db = null;
        this.isInitialized = false;
        
        this._initialize();
    }

    _initialize() {
        try {
            const dbPath = this.config.database.path;
            this.logger.debug('Initializing database', { path: dbPath });
            
            // Ensure database directory exists
            const dbDir = path.dirname(dbPath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            // Initialize database connection
            this.db = new Database(dbPath, {
                timeout: this.config.database.connectionTimeout
            });

            // Set busy timeout for concurrent access
            this.db.pragma(`busy_timeout = ${this.config.database.busyTimeout}`);
            
            // Enable WAL mode for better concurrency
            this.db.pragma('journal_mode = WAL');
            
            this._ensureTablesExist();
            this.isInitialized = true;
            
            this.logger.info('Database initialized successfully', { 
                path: dbPath,
                tracksCount: this.getTracksCount()
            });
            
        } catch (error) {
            this.logger.error('Failed to initialize database', { error: error.message });
            throw new DatabaseError('Database initialization failed', error);
        }
    }

    _ensureTablesExist() {
        const tracksTableExists = this.db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name='tracks'
        `).get();

        if (!tracksTableExists) {
            this.logger.info('Creating tracks table');
            this._createTracksTable();
        }

        const playlistsTableExists = this.db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name='playlists'
        `).get();

        if (!playlistsTableExists) {
            this.logger.info('Creating playlists table');
            this._createPlaylistsTable();
        }
    }

    _createTracksTable() {
        this.db.exec(`
            CREATE TABLE tracks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filepath TEXT UNIQUE NOT NULL,
                title TEXT,
                artist TEXT,
                album TEXT,
                duration REAL,
                track_number INTEGER,
                year INTEGER,
                file_size INTEGER,
                last_modified INTEGER,
                genre TEXT,
                composer TEXT,
                mood TEXT,
                energy_level REAL,
                tempo REAL,
                rating INTEGER DEFAULT 0,
                play_count INTEGER DEFAULT 0,
                last_played INTEGER,
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER DEFAULT (strftime('%s', 'now'))
            );

            CREATE INDEX idx_tracks_title ON tracks(title);
            CREATE INDEX idx_tracks_artist ON tracks(artist);
            CREATE INDEX idx_tracks_album ON tracks(album);
            CREATE INDEX idx_tracks_filepath ON tracks(filepath);
            CREATE INDEX idx_tracks_genre ON tracks(genre);
        `);
    }

    _createPlaylistsTable() {
        this.db.exec(`
            CREATE TABLE playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER DEFAULT (strftime('%s', 'now'))
            );

            CREATE TABLE playlist_tracks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                playlist_id INTEGER NOT NULL,
                track_id INTEGER NOT NULL,
                position INTEGER NOT NULL,
                added_at INTEGER DEFAULT (strftime('%s', 'now')),
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
                FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
                UNIQUE(playlist_id, track_id)
            );

            CREATE INDEX idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);
            CREATE INDEX idx_playlist_tracks_track ON playlist_tracks(track_id);
        `);
    }

    // Track operations
    getTrackById(trackId) {
        try {
            Validator.isValidTrackId(trackId);
            
            const stmt = this.db.prepare('SELECT * FROM tracks WHERE id = ?');
            const row = stmt.get(trackId);
            
            if (!row) {
                throw new NotFoundError('Track', trackId);
            }
            
            return this._rowToTrack(row);
            
        } catch (error) {
            if (error instanceof NotFoundError) throw error;
            this.logger.error('Failed to get track by ID', { trackId, error: error.message });
            throw new DatabaseError('Failed to retrieve track', error);
        }
    }

    searchTracks(query, options = {}) {
        try {
            const {
                limit = 10,
                fuzzy = false,
                exact = false,
                random = false
            } = options;

            Validator.isValidQuery(query);
            Validator.isValidLimit(limit);

            let sql;
            let params;

            if (exact) {
                sql = `
                    SELECT * FROM tracks 
                    WHERE title = ? OR artist = ? OR album = ?
                    ${random ? 'ORDER BY RANDOM()' : ''}
                    LIMIT ?
                `;
                params = [query, query, query, limit];
            } else if (fuzzy) {
                const fuzzyQuery = `%${query.split('').join('%')}%`;
                sql = `
                    SELECT * FROM tracks 
                    WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
                    ORDER BY 
                        ${random ? 'RANDOM()' : `
                        CASE 
                            WHEN title LIKE ? THEN 1
                            WHEN artist LIKE ? THEN 2
                            WHEN album LIKE ? THEN 3
                            ELSE 4
                        END`}
                    LIMIT ?
                `;
                if (random) {
                    params = [fuzzyQuery, fuzzyQuery, fuzzyQuery, limit];
                } else {
                    params = [fuzzyQuery, fuzzyQuery, fuzzyQuery, `%${query}%`, `%${query}%`, `%${query}%`, limit];
                }
            } else {
                const searchQuery = `%${query}%`;
                sql = `
                    SELECT * FROM tracks 
                    WHERE title LIKE ? OR artist LIKE ? OR album LIKE ? OR genre LIKE ?
                    ORDER BY 
                        ${random ? 'RANDOM()' : `
                        CASE 
                            WHEN title LIKE ? THEN 1
                            WHEN artist LIKE ? THEN 2
                            WHEN album LIKE ? THEN 3
                            ELSE 4
                        END`}
                    LIMIT ?
                `;
                if (random) {
                    params = [searchQuery, searchQuery, searchQuery, searchQuery, limit];
                } else {
                    params = [searchQuery, searchQuery, searchQuery, searchQuery, searchQuery, searchQuery, searchQuery, limit];
                }
            }

            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...params);
            
            return rows.map(row => this._rowToTrack(row));
            
        } catch (error) {
            this.logger.error('Failed to search tracks', { query, error: error.message });
            throw new DatabaseError('Search failed', error);
        }
    }

    getTracksCount() {
        try {
            const stmt = this.db.prepare('SELECT COUNT(*) as count FROM tracks');
            const result = stmt.get();
            return result.count;
        } catch (error) {
            this.logger.error('Failed to get tracks count', { error: error.message });
            return 0;
        }
    }

    getLibraryStats() {
        try {
            const stats = this.db.prepare(`
                SELECT 
                    COUNT(*) as total_tracks,
                    COUNT(DISTINCT artist) as total_artists,
                    COUNT(DISTINCT album) as total_albums,
                    COUNT(DISTINCT genre) as total_genres,
                    ROUND(SUM(duration) / 3600, 2) as total_hours,
                    ROUND(SUM(file_size) / 1024.0 / 1024.0 / 1024.0, 2) as total_size_gb
                FROM tracks
            `).get();

            return stats;
        } catch (error) {
            this.logger.error('Failed to get library stats', { error: error.message });
            throw new DatabaseError('Failed to get library statistics', error);
        }
    }

    // Transform database row to track object
    _rowToTrack(row) {
        const track = {
            id: row.id,
            title: row.title || 'Unknown Title',
            artist: row.artist || 'Unknown Artist',
            album: row.album || 'Unknown Album',
            genre: row.genre || 'Unknown Genre',
            composer: row.composer || 'Unknown Composer',
            filepath: row.filepath,
            duration: row.duration || 0,
            duration_formatted: this._formatDuration(row.duration || 0),
            track_number: row.track_number || 0,
            year: row.year || 0,
            file_size: row.file_size || 0,
            last_modified: row.last_modified || 0,
            filename: path.basename(row.filepath || ''),
            exists: fs.existsSync(row.filepath || ''),
            mood: row.mood,
            energy_level: row.energy_level,
            tempo: row.tempo,
            rating: row.rating || 0,
            play_count: row.play_count || 0,
            last_played: row.last_played,
            created_at: row.created_at,
            updated_at: row.updated_at
        };

        return track;
    }

    _formatDuration(seconds) {
        if (!seconds || seconds <= 0) return '00:00';
        
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        
        return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    // Playlist operations
    createPlaylist(name, description = '') {
        try {
            Validator.isNonEmptyString(name, 'name');
            
            const stmt = this.db.prepare(`
                INSERT INTO playlists (name, description) 
                VALUES (?, ?)
            `);
            
            const result = stmt.run(name, description);
            
            return {
                id: result.lastInsertRowid,
                name,
                description,
                created_at: Date.now()
            };
            
        } catch (error) {
            this.logger.error('Failed to create playlist', { name, error: error.message });
            throw new DatabaseError('Failed to create playlist', error);
        }
    }

    getPlaylists() {
        try {
            const stmt = this.db.prepare('SELECT * FROM playlists ORDER BY created_at DESC');
            return stmt.all();
        } catch (error) {
            this.logger.error('Failed to get playlists', { error: error.message });
            throw new DatabaseError('Failed to retrieve playlists', error);
        }
    }

    // Close database connection
    close() {
        if (this.db) {
            this.db.close();
            this.isInitialized = false;
            this.logger.debug('Database connection closed');
        }
    }

    // Health check
    isHealthy() {
        try {
            if (!this.db || !this.isInitialized) return false;
            
            // Simple query to test connection
            this.db.prepare('SELECT 1').get();
            return true;
        } catch (error) {
            this.logger.error('Database health check failed', { error: error.message });
            return false;
        }
    }
}

module.exports = DatabaseService;
