# Contributing to MusicPi Recorder

Thank you for your interest in contributing to MusicPi Recorder!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/yourusername/mixpi.git`
3. Create a branch: `git checkout -b feature/your-feature-name`
4. Make your changes
5. Run tests: `python -m pytest tests/`
6. Commit your changes: `git commit -m "Add your feature"`
7. Push to your fork: `git push origin feature/your-feature-name`
8. Create a Pull Request

## Development Setup

### Local Development

```bash
# Create virtual environment
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Copy configuration
cp config.yaml.example config.yaml

# Run application
python -m web.app
```

### Code Style

- Follow PEP 8 style guide
- Use type hints where appropriate
- Write docstrings for all public functions and classes
- Keep functions focused and small
- Add comments for complex logic

### Testing

- Write tests for new features
- Ensure all tests pass before submitting PR
- Aim for >80% code coverage
- Test error cases and edge cases

```bash
# Run all tests
python -m pytest tests/ -v

# Run with coverage
python -m pytest tests/ --cov=src --cov-report=html
```

## Pull Request Guidelines

1. **Clear Description**: Explain what your PR does and why
2. **Link Issues**: Reference any related issues
3. **Tests**: Include tests for new functionality
4. **Documentation**: Update README.md if needed
5. **Clean History**: Squash commits if necessary
6. **No Breaking Changes**: Avoid breaking existing functionality

## Reporting Bugs

When reporting bugs, please include:

- Operating system and version
- Python version
- Hardware details (Raspberry Pi model, X Air model)
- Steps to reproduce
- Expected vs actual behavior
- Error messages and logs

## Feature Requests

We welcome feature requests! Please:

- Check if the feature already exists
- Explain the use case
- Describe the expected behavior
- Consider implementation complexity

## Code Review Process

1. Maintainers will review your PR
2. Address any feedback or requested changes
3. Once approved, your PR will be merged
4. Your contribution will be credited in release notes

## Community Guidelines

- Be respectful and constructive
- Help others learn and grow
- Focus on the code, not the person
- Assume good intentions

## Questions?

Feel free to open an issue for questions or join our discussions.

Thank you for contributing!
