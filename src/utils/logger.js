/**
 * Logger Utility
 * Centralized logging with configurable levels and outputs
 */

class Logger {
    constructor(config = {}) {
        this.level = config.level || 'info';
        this.enableConsole = config.enableConsole !== false;
        this.enableFile = config.enableFile === true;
        this.context = config.context || '';
        
        this.levels = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3
        };
    }

    _shouldLog(level) {
        return this.levels[level] <= this.levels[this.level];
    }

    _formatMessage(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const contextStr = this.context ? `[${this.context}]` : '';
        const dataStr = data ? ` ${JSON.stringify(data)}` : '';
        return `${timestamp} ${level.toUpperCase()} ${contextStr} ${message}${dataStr}`;
    }

    _log(level, message, data = null) {
        if (!this._shouldLog(level)) return;

        const formattedMessage = this._formatMessage(level, message, data);
        
        if (this.enableConsole) {
            if (level === 'error') {
                console.error(formattedMessage);
            } else if (level === 'warn') {
                console.warn(formattedMessage);
            } else {
                console.log(formattedMessage);
            }
        }

        // File logging could be implemented here if needed
        if (this.enableFile) {
            // TODO: Implement file logging
        }
    }

    error(message, data = null) {
        this._log('error', message, data);
    }

    warn(message, data = null) {
        this._log('warn', message, data);
    }

    info(message, data = null) {
        this._log('info', message, data);
    }

    debug(message, data = null) {
        this._log('debug', message, data);
    }

    // Create child logger with context
    child(context) {
        return new Logger({
            level: this.level,
            enableConsole: this.enableConsole,
            enableFile: this.enableFile,
            context: this.context ? `${this.context}:${context}` : context
        });
    }

    // Create minimal logger for performance-critical code
    static createMinimal() {
        return {
            error: (msg) => console.error(msg),
            warn: () => {},
            info: () => {},
            debug: () => {}
        };
    }
}

module.exports = Logger;
