# 🎵 Music MCP Server

A **Model Context Protocol (MCP) Server** for music library management and Chromecast playbook control, optimized for LM Studio integration.

## ✨ Key Features

- **🎯 21 Music Tools** - Complete control over music playback and library
- **📡 Chromecast Integration** - Native Google Cast queue support  
- **⚡ Ultra-Fast Responses** - No timeout issues with LM Studio (~20ms)
- **🔄 Persistent Operation** - Background server survives disconnections
- **📚 Large Library Support** - Tested with 13,294+ tracks

## 🚀 Quick Start

### 1. Installation
```bash
git clone <repository>
cd music-mcp-server
npm install
```

### 2. Configure LM Studio
Add to your LM Studio MCP configuration:
```json
{
  "mcpServers": {
    "music": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["lm-studio-interface-minimal.js"],
      "cwd": "D:/mcp-server/music-mcp-server",
      "env": {
        "NODE_ENV": "production",
        "LOG_LEVEL": "error"
      },
      "timeout": 30000
    }
  }
}
```

### 3. Start Using
1. **Start server**: `start_music_server()`
2. **Find devices**: `list_chromecasts()`  
3. **Search music**: `search_music({"query": "artist name"})`
4. **Play tracks**: `play_multiple_tracks({"tracks": [1,2,3], "device_name": "device"})`

## 🛠️ Available Tools

### Server Management (3)
- `start_music_server` - Start background server
- `stop_music_server` - Stop background server  
- `server_status` - Check server health

### Chromecast Control (3)
- `list_chromecasts` - Discover devices
- `connect_chromecast` - Connect to device
- `get_chromecast_status` - Get connection status

### Music Library (2)
- `search_music` - Search tracks (supports fuzzy, exact matching)
- `get_library_stats` - Library statistics

### Playback (6)
- `play_track` - Play single track
- `play_multiple_tracks` - Play queue with native Cast support
- `pause_playback` / `resume_playbook` / `stop_playbook` - Playbook control
- `get_playlist_status` - Current playbook info

### Navigation (4)
- `skip_to_next` / `skip_to_previous` - Skip tracks
- `skip_to_track` - Jump to specific track number
- `seek_to_position` - Seek within track

### Queue & Volume (3)
- `manage_queue` - Add/remove/shuffle/repeat queue
- `set_volume` - Volume control (0.0-1.0)
- `manage_playlist` - Create/manage playlists

## 📁 Project Structure

```
music-mcp-server/
├── lm-studio-interface-minimal.js    # Main LM Studio interface
├── persistent-music-server.js        # Background music server
├── lm_studio_config_node.json       # LM Studio configuration
├── src/                              # Core application code
│   ├── controllers/                  # Music & Chromecast controllers
│   ├── services/                     # Database & Chromecast services
│   └── utils/                        # Utilities & validation
├── data/                             # Database & state files
├── docs/                             # API documentation
└── scripts/                          # Utility scripts
```

## 🔧 Architecture

### Two-Component Design
1. **lm-studio-interface-minimal.js** - Ultra-fast MCP interface for LM Studio
2. **persistent-music-server.js** - Background server for music operations

### Why This Works
- **No Timeouts**: Protocol methods respond instantly
- **Persistent State**: Music server runs independently  
- **Automatic Management**: Server starts/stops as needed
- **Error Recovery**: Robust error handling and reconnection

## 🎵 Supported Audio Formats

- MP3, FLAC, WAV, AAC, M4A, OGG, WMA
- Full ID3 metadata support
- Automatic content-type detection

## 📊 Performance

- **Library Size**: 13,294+ tracks tested
- **Response Time**: ~20ms for protocol methods
- **Memory Usage**: Optimized for large libraries
- **Network**: Efficient Chromecast streaming

## 🔍 Troubleshooting

### Common Issues
1. **Tools not loading**: Restart LM Studio after config changes
2. **Server not starting**: Check port 8765 availability
3. **Chromecast not found**: Ensure devices on same network
4. **Playback stops**: Check Chromecast connection stability

### Logs
- Server logs: `data/music-server.log`
- Check server status: `server_status()` tool

## 📄 License

MIT License - See LICENSE file for details

---

**Ready for production use with LM Studio!** 🎵
