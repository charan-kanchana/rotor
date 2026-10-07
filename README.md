# switchXprovider (Minimal)

Zero-dependency local proxy for Claude Code. Routes API traffic through multiple LLM providers with automatic failover, priority switching, alive health checks, and Claude model sentinel mapping.

Bind: `127.0.0.1:8787`

## Features

- **Multi-provider failover**: Automatically falls back to the next provider on HTTP error/rate-limit/timeout.
- **Priority ordering**: Reorder provider preference with single-click controls.
- **Provider health checks**: Test provider endpoints to verify they are alive and accessible.
- **Provider catalog + discover**: Built-in curated catalog of providers with one-click setup — just enter your API key.
- **Auto model discovery**: Fetch available model IDs directly from the provider's API.
- **Model sentinel mapping**: Map Claude Code requests (`opus`, `sonnet`, `haiku`) to target provider models.
- **Web dashboard**: Modern dark/light UI for overview, health monitoring, and provider management.
- **Zero dependencies**: Pure Node.js built-ins (`node:*`).

## Getting Started

```bash
# Start proxy
npm start

# Run self-check
npm test
```

Dashboard is accessible at [http://127.0.0.1:8787](http://127.0.0.1:8787).

## Architecture

- `server/server.mjs`: HTTP server, security checks (127.0.0.1 rebinding protection), route dispatch.
- `server/lib/config.mjs`: JSON config persistence (`~/.claude/switchx/config.json`) and event logging.
- `server/lib/proxy.mjs`: Core traffic forwarding, failover, cooldowns, model rewriting.
- `server/lib/translate.mjs`: Anthropic ⇄ OpenAI protocol conversion.
- `server/lib/api.mjs`: REST management API.
- `server/lib/health.mjs`: Health probes, model discovery.
- `server/catalog.json`: Curated provider catalog.
- `public/index.html`: Dashboard (System Overview + Providers & Discover).
