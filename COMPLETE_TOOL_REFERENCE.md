# Music MCP Server - Complete Tool Reference

The minimal interface now provides **21 comprehensive music tools** for controlling your music library and Chromecast devices through LM Studio.

## 🎯 Available Tools

### Server Management (3 tools)
- **`start_music_server`** - Start the persistent music server in the background
- **`stop_music_server`** - Stop the persistent music server
- **`server_status`** - Check the status of the persistent music server

### Chromecast Discovery & Connection (3 tools)
- **`list_chromecasts`** - List all available Chromecast devices on the network
- **`connect_chromecast`** - Connect to a specific Chromecast device
- **`get_chromecast_status`** - Get current Chromecast connection and playback status

### Music Library & Search (2 tools)
- **`search_music`** - Search for music tracks by artist, title, album, or any text
  - Supports: basic, exact, fuzzy search types
  - Options: limit (1-50), random results
- **`get_library_stats`** - Get comprehensive statistics about the music library

### Single & Multi-Track Playback (2 tools)
- **`play_track`** - Play a single track on a Chromecast device
- **`play_multiple_tracks`** - Play a queue of multiple tracks with native Cast queue support
  - Features: shuffle, start index, device selection
  - Uses Google Cast native queue for seamless playback

### Playback Control (4 tools)
- **`pause_playback`** - Pause current playback on the connected Chromecast
- **`resume_playback`** - Resume paused playback on the connected Chromecast
- **`stop_playback`** - Stop current playback on the connected Chromecast
- **`get_playlist_status`** - Get current playback status, queue information, and now playing details

### Navigation & Seeking (4 tools)
- **`skip_to_next`** - Skip to the next track in the queue
- **`skip_to_previous`** - Skip to the previous track in the queue
- **`skip_to_track`** - Skip to a specific track number in the queue (1-based)
- **`seek_to_position`** - Seek to a specific position in the current track (seconds)

### Queue Management (1 tool)
- **`manage_queue`** - Comprehensive queue management
  - Actions: add, remove, clear, shuffle, restore, repeat, info
  - Repeat modes: none, one, all
  - Full queue control capabilities

### Volume Control (1 tool)
- **`set_volume`** - Set the volume of the Chromecast device (0.0 to 1.0)

### Playlist Management (1 tool)
- **`manage_playlist`** - Create, list, or manage saved playlists
  - Actions: create, list, delete, load
  - Persistent playlist storage

## 🚀 Quick Start Examples

### Basic Usage
1. **Start the server**: `start_music_server()`
2. **Find devices**: `list_chromecasts()`
3. **Search music**: `search_music({"query": "Arthur H", "limit": 5})`
4. **Play tracks**: `play_multiple_tracks({"tracks": [1, 2, 3], "device_name": "LS50-Wireless-II-...", "shuffle": false})`

### Advanced Controls
- **Volume**: `set_volume({"volume": 0.7})`
- **Skip**: `skip_to_next()` or `skip_to_track({"track_number": 3})`
- **Queue**: `manage_queue({"action": "shuffle"})` or `manage_queue({"action": "repeat", "mode": "all"})`
- **Status**: `get_playlist_status()` for complete playback information

## 📊 Current Library Stats
- **13,294 tracks** available for playback
- **2 Chromecast devices** detected (LS50-Wireless-II, BeyondTV2)
- **Native Google Cast queue** support for seamless multi-track playback

## ⚡ Performance
- **Protocol methods** (initialize, tools/list): ~20ms response time
- **Music commands**: Forward to persistent server for full functionality
- **No timeout issues**: All commands respond within LM Studio limits

## 🎵 Ready for Production
The music server is now fully functional with comprehensive tool coverage for all music playback needs!
