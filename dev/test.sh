#!/bin/bash
# Run MixPi Tests

set -e

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Check if venv exists
if [ ! -d "venv" ]; then
    echo "Virtual environment not found!"
    echo "Run ./dev/setup.sh first"
    exit 1
fi

# Activate virtual environment
source venv/bin/activate

# Ensure dev dependencies are installed
pip install -r requirements-dev.txt --quiet

echo "=========================================="
echo "MixPi Test Suite"
echo "=========================================="
echo ""

# Parse arguments
VERBOSE=""
COVERAGE=""
SPECIFIC_TEST=""

for arg in "$@"; do
    case $arg in
        -v|--verbose)
            VERBOSE="-v"
            shift
            ;;
        --coverage)
            COVERAGE="--cov=src --cov=web --cov=osc --cov-report=html --cov-report=term"
            shift
            ;;
        *)
            SPECIFIC_TEST="$arg"
            ;;
    esac
done

# Run tests
if [ -n "$SPECIFIC_TEST" ]; then
    echo "Running specific test: $SPECIFIC_TEST"
    python -m pytest $VERBOSE $COVERAGE "$SPECIFIC_TEST"
else
    echo "Running all tests..."
    python -m pytest $VERBOSE $COVERAGE tests/
fi

# Show coverage report location if generated
if [ -n "$COVERAGE" ]; then
    echo ""
    echo "Coverage report generated: htmlcov/index.html"
    echo "Open with: xdg-open htmlcov/index.html"
fi

echo ""
echo "Tests complete!"
