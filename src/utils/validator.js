/**
 * Validation Utilities
 * Input validation and sanitization helpers
 */

const { ValidationError } = require('./errors');

class Validator {
    static isInteger(value, fieldName = 'value') {
        if (!Number.isInteger(value)) {
            throw new ValidationError(`${fieldName} must be an integer`, fieldName);
        }
        return true;
    }

    static isPositiveInteger(value, fieldName = 'value') {
        this.isInteger(value, fieldName);
        if (value <= 0) {
            throw new ValidationError(`${fieldName} must be a positive integer`, fieldName);
        }
        return true;
    }

    static isString(value, fieldName = 'value') {
        if (typeof value !== 'string') {
            throw new ValidationError(`${fieldName} must be a string`, fieldName);
        }
        return true;
    }

    static isNonEmptyString(value, fieldName = 'value') {
        this.isString(value, fieldName);
        if (value.trim().length === 0) {
            throw new ValidationError(`${fieldName} cannot be empty`, fieldName);
        }
        return true;
    }

    static isNumber(value, fieldName = 'value') {
        if (typeof value !== 'number' || isNaN(value)) {
            throw new ValidationError(`${fieldName} must be a number`, fieldName);
        }
        return true;
    }

    static isInRange(value, min, max, fieldName = 'value') {
        this.isNumber(value, fieldName);
        if (value < min || value > max) {
            throw new ValidationError(`${fieldName} must be between ${min} and ${max}`, fieldName);
        }
        return true;
    }

    static isVolume(value, fieldName = 'volume') {
        return this.isInRange(value, 0.0, 1.0, fieldName);
    }

    static isValidTrackId(trackId) {
        return this.isPositiveInteger(trackId, 'track_id');
    }

    static isValidQuery(query) {
        this.isNonEmptyString(query, 'query');
        if (query.length > 1000) {
            throw new ValidationError('Query is too long (max 1000 characters)', 'query');
        }
        return true;
    }

    static isValidLimit(limit) {
        this.isPositiveInteger(limit, 'limit');
        if (limit > 1000) {
            throw new ValidationError('Limit is too high (max 1000)', 'limit');
        }
        return true;
    }

    static sanitizeString(str) {
        if (typeof str !== 'string') return '';
        return str.trim().replace(/[<>]/g, '');
    }

    static sanitizeQuery(query) {
        if (typeof query !== 'string') return '';
        return query.trim().slice(0, 1000);
    }
}

module.exports = Validator;
