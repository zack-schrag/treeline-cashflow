# Treeline Cash Flow Plugin

Project your future account balance based on recurring income and expenses.

## Features

- **Auto-detection**: Analyzes your transaction history to find recurring income and expenses (paychecks, bills, subscriptions)
- **Balance projection**: See your projected balance 30, 60, or 90 days into the future
- **Upcoming transactions**: View a list of expected transactions in chronological order
- **Hide/unhide**: Exclude false positives from your projections
- **Monthly summary**: See your estimated monthly income, expenses, and net cash flow

## How It Works

The plugin uses SQL pattern matching to detect recurring transactions:
- Finds transactions with similar descriptions and amounts
- Uses fuzzy matching (Jaro-Winkler similarity) to group merchant name variations
- Calculates average intervals and filters for consistent patterns (low standard deviation)
- Requires 3+ occurrences to detect a pattern

## Installation

### From Source

```bash
# Clone the repo
git clone https://github.com/zack-schrag/treeline-cashflow.git
cd treeline-cashflow

# Install dependencies and build
npm install
npm run build

# Install the plugin
tl plugin install /path/to/treeline-cashflow
```

### From GitHub Release

```bash
tl plugin install https://github.com/zack-schrag/treeline-cashflow
```

## Usage

Once installed, you'll see "Cash Flow" in the sidebar. The view shows:

1. **Summary cards**: Current balance, projected balance, lowest point, monthly net
2. **Upcoming transactions**: Chronological list of expected income/expenses
3. **Detected recurring**: All auto-detected patterns with ability to hide false positives
4. **Balance timeline**: Key balance points over the projection horizon

### Keyboard Shortcuts

- `j` / `k` - Navigate up/down in the recurring list
- `Enter` - View transactions for selected item in Query Editor
- `h` - Hide/restore selected item from projections
- `1` / `2` / `3` - Set horizon to 30/60/90 days

## Development

```bash
npm install        # Install dependencies
npm run dev        # Start dev server with hot reload
npm run build      # Build for production
npm run check      # Type check
```

## Releasing

```bash
./scripts/release.sh 0.1.0
```

This tags the release and pushes to GitHub. The included GitHub Action automatically builds and publishes the release with the required assets.

## License

MIT
