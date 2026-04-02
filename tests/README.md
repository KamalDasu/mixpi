# MusicPi Recorder Tests

## Running Tests

### All Tests

Run all unit tests:

```bash
python -m pytest tests/
```

Or using unittest:

```bash
python -m unittest discover tests/
```

### Specific Test Files

Run specific test file:

```bash
python -m pytest tests/test_audio_engine.py
python -m pytest tests/test_storage.py
```

### With Coverage

Install coverage:

```bash
pip install pytest-cov
```

Run tests with coverage:

```bash
python -m pytest tests/ --cov=src --cov-report=html
```

View coverage report:

```bash
open htmlcov/index.html
```

## Test Structure

- `test_audio_engine.py` - Tests for audio recording engine
- `test_storage.py` - Tests for storage manager and file operations

## Writing New Tests

Follow these conventions:

1. Create test file with `test_` prefix
2. Create test class inheriting from `unittest.TestCase`
3. Name test methods with `test_` prefix
4. Use `setUp()` and `tearDown()` for fixtures
5. Clean up temporary files in `tearDown()`

Example:

```python
import unittest

class TestMyFeature(unittest.TestCase):
    def setUp(self):
        # Setup test fixtures
        pass
    
    def tearDown(self):
        # Clean up
        pass
    
    def test_my_feature(self):
        # Test code
        self.assertEqual(1 + 1, 2)
```

## Continuous Integration

Tests should pass before committing code. Run tests locally:

```bash
python -m pytest tests/ -v
```

## Test Coverage Goals

- Core modules: >80% coverage
- Critical paths: 100% coverage
- Error handling: Test all error cases

## Hardware Tests

Some tests require actual hardware (X Air 18, audio interface). These are marked with `@unittest.skip` by default.

To run hardware tests:

```bash
python -m pytest tests/ --run-hardware
```

## Performance Tests

Performance tests verify recording stability:

```bash
python -m pytest tests/test_performance.py -v
```

These tests:
- Record for extended periods
- Monitor CPU usage
- Check for buffer overruns
- Verify file integrity
