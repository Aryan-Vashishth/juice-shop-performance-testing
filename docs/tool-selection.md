# Tool Selection: Why k6

## Decision

**k6 v2.3.0** (Grafana Labs, open source, AGPL-3.0) is the performance testing tool for this assignment.

## Candidates compared

| Criterion | k6 | Apache JMeter | Artillery |
|---|---|---|---|
| Test scripts | JavaScript code | XML plans built in a GUI | YAML, plus JavaScript hooks |
| Fits code review and git diffs | Yes: plain `.js` files | Poorly: large generated XML | Yes |
| Load generator | Go, one process, low memory per virtual user | Java, one thread per user, high memory | Node.js, single-threaded |
| Pass/fail criteria in the script | Built-in `thresholds` that set the exit code | Assertions plus plugins or post-processing | `ensure` checks |
| Load models | Ramping users, constant and ramping arrival rate, per-scenario | Thread groups, plugins for arrival rate | Arrival phases |
| HTML report with graphs | Built in (web dashboard export) | Built in (HTML dashboard) | Paid cloud, or third-party |
| Install | One portable `.exe`, no runtime | Needs a Java runtime | Needs Node.js and npm |
| Protocol coverage | HTTP, WebSockets, gRPC, browser | Widest (JDBC, JMS, FTP, LDAP ...) | HTTP, WebSockets, Socket.IO, Playwright |

## Why k6 won

1. **Tests are code.** The scenarios need logic: register a pool of users in `setup()`, keep a
   login session per virtual user, pick products that are in stock, and split traffic 70/10/20
   between request types. In k6 that is ordinary JavaScript. In JMeter the same logic needs
   controllers, extractors and Groovy snippets spread across a GUI-built XML file.
2. **Assertions are pass/fail gates.** `thresholds` such as `p(95)<500` on a single request type
   are part of the script. A breach makes `k6 run` exit non-zero, so the same scripts can gate a
   CI pipeline without extra tooling.
3. **Accurate load from one laptop.** All tests ran on one machine, with the app and the load
   generator sharing the CPU. k6's Go runtime uses far less CPU and memory per virtual user than
   JMeter's thread-per-user model, which leaves more CPU for the application being measured.
4. **Arrival-rate load models.** The stress test uses `ramping-arrival-rate`, which keeps sending
   requests at the target rate even when the server slows down. A closed model (fixed users
   waiting for responses) would back off as the app slowed and hide the breaking point.
5. **Zero-install setup.** k6 is a single executable that `run.ps1` downloads, so the repo runs
   right after cloning.

## Trade-offs accepted

- **No GUI recorder.** Requests were written by hand from Juice Shop's REST API rather than
  recorded from a browser. For an API-driven single-page app this is a small cost.
- **Not a browser test.** k6 measures server response times, not page rendering in the browser.
  That matches the goal of finding back-end bottlenecks. k6 has a browser module if front-end
  timings are needed later.
- **Narrower protocol support than JMeter.** It isn't needed here: Juice Shop is HTTP and JSON only.
