# Quick Start

You need Windows 10 or 11, Git and an internet connection. Nothing else needs to be installed.

## 1. Clone

```powershell
git clone https://github.com/Aryan-Vashishth/juice-shop-performance-testing.git
cd juice-shop-performance-testing
```

## 2. Run

```powershell
.\run.ps1 all
```

This takes about 22 minutes. The first run also downloads Node.js, Juice Shop and k6 into the
folder (about 190 MB) and starts Juice Shop by itself.

To run a single test instead: `.\run.ps1 smoke` (seconds), `.\run.ps1 product-search`,
`.\run.ps1 login` or `.\run.ps1 basket` (about 5 minutes each), or `.\run.ps1 stress` (about 8 minutes).

If PowerShell says "running scripts is disabled on this system", run this instead:

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 all
```

## 3. See the results

- **In the terminal:** each test ends with a summary. A green ✓ next to a threshold means it passed
  and a red ✗ means it failed.
- **In a browser:** open `results\<run>\<test>-dashboard.html` for graphs of that test.
  `<run>` is the date and time the run started, for example `results\2026-10-27_13-20-07\`.
- **Full analysis:** open [docs/report/performance-test-report.html](docs/report/performance-test-report.html),
  or the PDF next to it. It shows the results of the runs it was built from. To rebuild it from
  your own run, see "How reporting works" in the README.

For anything more, see [README.md](README.md).
