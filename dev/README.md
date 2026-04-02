# Local Development Setup

This directory contains tools and configurations for local development and testing.

## Quick Start

### First Time Setup
```bash
# From the mixpi root directory
./dev/setup.sh
```

This will:
- Install system dependencies (requires sudo)
- Create virtual environment
- Install Python packages
- Create local config file
- Set up development database/storage

### Daily Development

```bash
# Start development server
./dev/run.sh

# Or manually:
source venv/bin/activate
python -m web.app
```

### Run Tests
```bash
./dev/test.sh
```

### Clean Development Environment
```bash
./dev/clean.sh
```

## Development Configuration

The `dev/` directory includes:

- `setup.sh` - One-time setup script
- `run.sh` - Start development server
- `test.sh` - Run test suite
- `clean.sh` - Clean temporary files
- `config.dev.yaml` - Development configuration
- `mock_audio.py` - Mock audio device for testing without hardware

## Configuration

Development uses `dev/config.dev.yaml` which is configured for local testing:
- Uses local storage (`./dev/recordings`)
- Debug mode enabled
- Mock audio device (no hardware required)
- OSC integration disabled by default

## Testing Without Hardware

You can test the application without X Air 18 hardware:

```bash
# Use mock audio device
./dev/run.sh --mock

# Or set in config:
# audio.device: "mock"
```

The mock device simulates:
- 18 audio channels
- Level meters with random data
- Recording to files (silent audio)

## Directory Structure

```
dev/
├── README.md           # This file
├── setup.sh            # Initial setup
├── run.sh              # Start dev server
├── test.sh             # Run tests
├── clean.sh            # Clean environment
├── config.dev.yaml     # Dev configuration
├── mock_audio.py       # Mock audio device
├── recordings/         # Local recordings (gitignored)
└── logs/               # Development logs (gitignored)
```

## Tips

### View Logs
```bash
tail -f dev/logs/mixpi.log
```

### Reset Everything
```bash
./dev/clean.sh --all
./dev/setup.sh
```

### Test API Endpoints
```bash
# Get status
curl http://localhost:5000/api/recording/status

# List devices
curl http://localhost:5000/api/devices

# Start recording
curl -X POST http://localhost:5000/api/recording/start \
  -H "Content-Type: application/json" \
  -d '{"venue": "Dev Test", "artist": "Test Band"}'
```

### Debug Mode
Edit `dev/config.dev.yaml`:
```yaml
web:
  debug: true  # Enable Flask debug mode
```

### Different Port
```bash
# Run on different port
PORT=8080 ./dev/run.sh
```

## Common Issues

### Port Already in Use
```bash
# Find process using port 5000
lsof -i :5000

# Kill it
kill -9 <PID>
```

### Virtual Environment Issues
```bash
# Remove and recreate
rm -rf venv
./dev/setup.sh
```

### Audio Device Not Found
Use mock device:
```bash
./dev/run.sh --mock
```

## IDE Setup

### VS Code
Recommended extensions:
- Python
- Pylance
- Python Test Explorer

Settings (`.vscode/settings.json`):
```json
{
  "python.defaultInterpreterPath": "${workspaceFolder}/venv/bin/python",
  "python.testing.pytestEnabled": true,
  "python.testing.unittestEnabled": false
}
```

### PyCharm
1. File → Settings → Project → Python Interpreter
2. Add Interpreter → Existing Environment
3. Select: `<project>/venv/bin/python`

## Contributing

When developing:
1. Create feature branch: `git checkout -b feature/your-feature`
2. Make changes
3. Run tests: `./dev/test.sh`
4. Commit: `git commit -m "Add feature"`
5. Push and create PR

See [CONTRIBUTING.md](../CONTRIBUTING.md) for details.
