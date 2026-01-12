/**
 * Logger utility with consistent formatting and local timestamps
 * Uses getLocalTimestamp for consistent timezone-aware logging
 */

import { getLocalTimestamp } from './timestamp.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogOptions {
  /** Log level (default: 'info') */
  level?: LogLevel;
  /** Additional metadata to include */
  meta?: Record<string, any>;
  /** Component/module name for context */
  component?: string;
}

/**
 * Format a log message with timestamp, level, and optional component
 */
function formatLogMessage(
  level: LogLevel,
  message: string,
  options: LogOptions = {}
): string {
  const timestamp = getLocalTimestamp();
  const levelUpper = level.toUpperCase().padEnd(5);
  const component = options.component ? `[${options.component}]` : '';
  const metaStr = options.meta ? ` ${JSON.stringify(options.meta)}` : '';
  
  return `[${timestamp}] [${levelUpper}]${component ? ' ' + component : ''} ${message}${metaStr}`;
}

/**
 * Simple logger that formats messages consistently
 */
export class Logger {
  private component?: string;

  constructor(component?: string) {
    this.component = component;
  }

  /**
   * Create a child logger with a sub-component name
   */
  child(subComponent: string): Logger {
    const fullComponent = this.component
      ? `${this.component}:${subComponent}`
      : subComponent;
    return new Logger(fullComponent);
  }

  /**
   * Log a debug message
   */
  debug(message: string, meta?: Record<string, any>): void {
    console.debug(formatLogMessage('debug', message, { component: this.component, meta }));
  }

  /**
   * Log an info message
   */
  info(message: string, meta?: Record<string, any>): void {
    console.log(formatLogMessage('info', message, { component: this.component, meta }));
  }

  /**
   * Log a warning message
   */
  warn(message: string, meta?: Record<string, any>): void {
    console.warn(formatLogMessage('warn', message, { component: this.component, meta }));
  }

  /**
   * Log an error message
   */
  error(message: string, error?: Error | any, meta?: Record<string, any>): void {
    const errorMeta = error instanceof Error
      ? { ...meta, error: error.message, stack: error.stack }
      : error
        ? { ...meta, error: String(error) }
        : meta;
    console.error(formatLogMessage('error', message, { component: this.component, meta: errorMeta }));
  }

  /**
   * Log with custom level
   */
  log(level: LogLevel, message: string, meta?: Record<string, any>): void {
    const formatted = formatLogMessage(level, message, { component: this.component, meta });
    switch (level) {
      case 'debug':
        console.debug(formatted);
        break;
      case 'info':
        console.log(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'error':
        console.error(formatted);
        break;
    }
  }
}

/**
 * Create a logger instance
 */
export function createLogger(component?: string): Logger {
  return new Logger(component);
}

/**
 * Default logger instance
 */
export const logger = createLogger();
