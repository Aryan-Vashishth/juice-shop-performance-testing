# Juice Shop Performance Testing

Performance tests for [OWASP Juice Shop](https://github.com/juice-shop/juice-shop), written with [k6](https://k6.io/).
Covers three modules: product search, login and basket.

## Setup

1. **Juice Shop v20.3.0.** Download the Node 24 Windows build from the
   [Juice Shop releases](https://github.com/juice-shop/juice-shop/releases/tag/v20.3.0)
   and unzip it to `app/juice-shop_20.3.0`. Start it in its own terminal:
   ```powershell
   cd app\juice-shop_20.3.0
   npm start
   ```
   Wait for `Server listening on port 3000`.
2. **k6 v2.3.0.** Download the portable Windows build from the
   [k6 releases](https://github.com/grafana/k6/releases) and unzip it to `tools/k6-v2.3.0-windows-amd64`.

## Running tests

```powershell
.\run.ps1 smoke
```

Each run saves a summary to `results/<test>-summary.json`.
Set `BASE_URL` to target a different host (default `http://localhost:3000`).

## Layout

| Path | Contents |
|---|---|
| `scripts/` | k6 test scripts |
| `results/` | Run summaries |
| `run.ps1` | Runs a script from `scripts/` by name |
