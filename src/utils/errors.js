/**
 * Custom Error Classes
 * Application-specific error types for better error handling
 */

class AppError extends Error {
    constructor(message, statusCode = 500, isOperational = true) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        
        Error.captureStackTrace(this, this.constructor);
    }
}

class DatabaseError extends AppError {
    constructor(message, originalError = null) {
        super(message, 500);
        this.originalError = originalError;
    }
}

class ChromecastError extends AppError {
    constructor(message, deviceName = null) {
        super(message, 503);
        this.deviceName = deviceName;
    }
}

class ValidationError extends AppError {
    constructor(message, field = null) {
        super(message, 400);
        this.field = field;
    }
}

class NotFoundError extends AppError {
    constructor(resource, identifier = null) {
        const message = identifier 
            ? `${resource} with identifier '${identifier}' not found`
            : `${resource} not found`;
        super(message, 404);
        this.resource = resource;
        this.identifier = identifier;
    }
}

class ServiceUnavailableError extends AppError {
    constructor(serviceName) {
        super(`${serviceName} service is not available`, 503);
        this.serviceName = serviceName;
    }
}

module.exports = {
    AppError,
    DatabaseError,
    ChromecastError,
    ValidationError,
    NotFoundError,
    ServiceUnavailableError
};
