#!/bin/bash
# Clean Development Environment

set -e

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

echo "=========================================="
echo "MixPi Development Cleanup"
echo "=========================================="
echo ""

# Parse arguments
CLEAN_ALL=false

for arg in "$@"; do
    case $arg in
        --all)
            CLEAN_ALL=true
            shift
            ;;
        *)
            ;;
    esac
done

# Clean Python cache
echo "Cleaning Python cache files..."
find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find . -type f -name "*.pyc" -delete 2>/dev/null || true
find . -type f -name "*.pyo" -delete 2>/dev/null || true

# Clean test artifacts
echo "Cleaning test artifacts..."
rm -rf .pytest_cache
rm -rf htmlcov
rm -f .coverage

# Clean logs
echo "Cleaning logs..."
rm -rf dev/logs/*.log 2>/dev/null || true

# Clean recordings
if [ "$CLEAN_ALL" = true ]; then
    echo "Cleaning recordings..."
    rm -rf dev/recordings/* 2>/dev/null || true
    
    echo "Removing virtual environment..."
    rm -rf venv
    
    echo "Removing config files..."
    rm -f config.yaml
    rm -f dev/config.dev.yaml
fi

echo ""
echo "Cleanup complete!"

if [ "$CLEAN_ALL" = true ]; then
    echo ""
    echo "Full cleanup performed. Run ./dev/setup.sh to reinitialize."
else
    echo ""
    echo "To perform full cleanup (including venv and configs):"
    echo "  ./dev/clean.sh --all"
fi
