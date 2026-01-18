#!/bin/bash
# RagForge Daemon Management Script
# Usage: ./scripts/daemon.sh [start|stop|restart|status|logs]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DAEMON_PORT=6969
PID_FILE="$HOME/.ragforge/daemon.pid"
LOG_FILE="$HOME/.ragforge/logs/daemon.log"

cd "$PROJECT_DIR"

start_daemon() {
    # Check if already running
    if curl -s "http://127.0.0.1:$DAEMON_PORT/health" > /dev/null 2>&1; then
        echo "Daemon already running on port $DAEMON_PORT"
        return 0
    fi

    echo "Starting daemon with tsx (source mode)..."

    # Run daemon directly from source with tsx
    nohup npx tsx src/cli/commands/daemon.ts start > /dev/null 2>&1 &

    # Wait for daemon to be ready
    echo -n "Waiting for daemon"
    for i in {1..60}; do
        if curl -s "http://127.0.0.1:$DAEMON_PORT/health" > /dev/null 2>&1; then
            echo " Ready!"
            return 0
        fi
        echo -n "."
        sleep 1
    done

    echo " Timeout!"
    return 1
}

stop_daemon() {
    if curl -s "http://127.0.0.1:$DAEMON_PORT/shutdown" -X POST > /dev/null 2>&1; then
        echo "Daemon shutdown initiated"
        sleep 2
    else
        echo "Daemon not running"
    fi
}

restart_daemon() {
    echo "Restarting daemon..."
    stop_daemon
    sleep 1
    start_daemon
}

status_daemon() {
    if curl -s "http://127.0.0.1:$DAEMON_PORT/status" 2>/dev/null; then
        echo ""
    else
        echo "Daemon not running"
    fi
}

logs_daemon() {
    if [ -f "$LOG_FILE" ]; then
        tail -f "$LOG_FILE"
    else
        echo "Log file not found: $LOG_FILE"
    fi
}

case "${1:-help}" in
    start)
        start_daemon
        ;;
    stop)
        stop_daemon
        ;;
    restart)
        restart_daemon
        ;;
    status)
        status_daemon
        ;;
    logs)
        logs_daemon
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        echo ""
        echo "Commands:"
        echo "  start   - Start daemon with tsx (uses source code directly)"
        echo "  stop    - Stop the running daemon"
        echo "  restart - Stop and start daemon (picks up code changes)"
        echo "  status  - Show daemon status"
        echo "  logs    - Tail daemon logs"
        ;;
esac
