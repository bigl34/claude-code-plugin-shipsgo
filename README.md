<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-shipsgo

ShipsGo ocean container tracking with vessel positions and ETA monitoring

![Version](https://img.shields.io/badge/version-1.0.8-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- Shipment Management
- **create-shipment** — Create/track a new shipment (uses 1 credit if new)
- **get-shipment** — Get shipment details by ID
- **list-shipments** — List shipments with filters
- Tracking Queries
- **track-bl** — Track by Bill of Lading
- **track-container** — Track by container number
- **track-booking** — Track by booking number
- **search** — Search by any reference
- Monitoring
- **active** — List all active (in-transit) shipments
- **arriving-soon** — Shipments arriving within N days
- **milestones** — Get tracking milestones for a shipment
- **vessel-position** — Get live vessel coordinates
- Utilities
- **api-status** — Check API connectivity and authentication
- **rate-limit** — Show current rate limit status
- **refresh-shipment --id <id>** — Force re-poll, bypassing cache
- **get-sharing-link --id <id>** — Get shareable public tracking link
- **list-tools** — List all available commands
- Cache Management
- **cache-stats** — Show cache statistics
- **cache-clear** — Clear all cached data
- **cache-invalidate --id <id>** — Invalidate specific shipment cache

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- API credentials for the target service (see Configuration)

## Quick Start

```bash
git clone https://github.com/YOUR_GITHUB_USER/claude-code-plugin-shipsgo.git
cd claude-code-plugin-shipsgo
cp scripts/config.template.json scripts/config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js create-shipment
```

## Installation

1. Clone this repository
2. Copy `scripts/config.template.json` to `scripts/config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```

## Configuration

Copy `scripts/config.template.json` to `scripts/config.json` and fill in the required values:

| Field | Placeholder |
|-------|-------------|
| `shipsgo.apiKey` | `YOUR_API_KEY` |
| `shipsgo.baseUrl` | `https://api.shipsgo.com/v2` |

## Available Commands

### Shipment Management

| Command           | Description                                        | Required Options                                                      |
| ----------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| `create-shipment` | Create/track a new shipment (uses 1 credit if new) | `--bl`, `--container`, or `--booking` (at least one)                  |
| `get-shipment`    | Get shipment details by ID                         | `--id <shipment_id>`                                                  |
| `list-shipments`  | List shipments with filters                        | Optional: `--status`, `--limit`, `--offset`, `--eta-from`, `--eta-to` |

### Tracking Queries

| Command           | Description               | Required Options              |
| ----------------- | ------------------------- | ----------------------------- |
| `track-bl`        | Track by Bill of Lading   | `--number <bl_number>`        |
| `track-container` | Track by container number | `--number <container_number>` |
| `track-booking`   | Track by booking number   | `--number <booking_number>`   |
| `search`          | Search by any reference   | `--query <reference>`         |

### Monitoring

| Command           | Description                            | Options                   |
| ----------------- | -------------------------------------- | ------------------------- |
| `active`          | List all active (in-transit) shipments | None                      |
| `arriving-soon`   | Shipments arriving within N days       | `--days <n>` (default: 7) |
| `milestones`      | Get tracking milestones for a shipment | `--id <shipment_id>`      |
| `vessel-position` | Get live vessel coordinates            | `--id <shipment_id>`      |

### Utilities

| Command                      | Description                               |
| ---------------------------- | ----------------------------------------- |
| `api-status`                 | Check API connectivity and authentication |
| `rate-limit`                 | Show current rate limit status            |
| `refresh-shipment --id <id>` | Force re-poll, bypassing cache            |
| `get-sharing-link --id <id>` | Get shareable public tracking link        |
| `list-tools`                 | List all available commands               |

### Cache Management

| Command                      | Description                        |
| ---------------------------- | ---------------------------------- |
| `cache-stats`                | Show cache statistics              |
| `cache-clear`                | Clear all cached data              |
| `cache-invalidate --id <id>` | Invalidate specific shipment cache |

## Usage Examples

```bash
node scripts/dist/cli.js create-shipment --container HAMU1058953 --reference SO-12345
```

```bash
node scripts/dist/cli.js arriving-soon --days 14
```

```bash
node scripts/dist/cli.js vessel-position --id abc123
```

```bash
node scripts/dist/cli.js search --query SO-12345
```

```bash
node scripts/dist/cli.js get-sharing-link --id 5773482
# Returns: https://map.shipsgo.com/ocean/shipments/1234567?token=example-token-uuid
```

## How It Works

This plugin connects directly to the service's HTTP API. The CLI handles authentication, request formatting, pagination, and error handling, returning structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
