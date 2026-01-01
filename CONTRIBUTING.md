# Contributing to Apple Notes MCP Server

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/sweetrb/mcp-apple-notes.git
   cd mcp-apple-notes
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the project**
   ```bash
   npm run build
   ```

4. **Run tests**
   ```bash
   npm test
   ```

## Code Style

This project uses ESLint and Prettier for code quality and formatting.

```bash
# Check for linting issues
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check
```

## Testing

All new features should include tests. We use Vitest for testing.

```bash
# Run tests once
npm test

# Run tests in watch mode
npm run test:watch
```

### Testing Guidelines

- Tests mock the `runAppleScript` function since AppleScript only works on macOS
- Test both success and failure paths
- Test edge cases (empty strings, special characters, etc.)

## Pull Request Process

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Follow the existing code style
   - Add JSDoc comments for new functions
   - Add tests for new functionality

3. **Run all checks**
   ```bash
   npm run lint
   npm run typecheck
   npm test
   npm run build
   ```

4. **Commit your changes**
   - Use clear, descriptive commit messages
   - Reference any related issues

5. **Push and create a PR**
   - Describe what your PR does
   - Link any related issues

## Adding New Tools

When adding a new MCP tool:

1. **Add the schema** in `src/index.ts`
2. **Implement the method** in `src/services/appleNotesManager.ts`
3. **Add type definitions** in `src/types.ts`
4. **Write tests** in `src/services/appleNotesManager.test.ts`
5. **Update documentation** in README.md and CHANGELOG.md

## AppleScript Guidelines

- Always escape user input using `escapeForAppleScript()` for plain text or `escapeHtmlForAppleScript()` for HTML content
- Handle errors gracefully (return null/false instead of throwing)
- Log errors with `console.error()` for debugging
- Test on actual macOS when possible

## Questions?

Open an issue for any questions about contributing.
