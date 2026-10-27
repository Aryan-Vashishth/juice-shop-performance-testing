// Written analysis for the performance test report, as HTML fragments.
// Numbers quoted here come from the run folders in results/; tables and charts are generated from them.
module.exports = {
  date: '27 October 2026',

  summary: `
<p><b>All three modules pass their load tests</b> at the planned load (50 concurrent shoppers for search,
30 for login and basket): no failed requests, every check passed, and every request type well inside its
response-time limit.</p>
<p><b>Product search breaks between 40 and 50 requests per second.</b> Up to 40 req/s, the 95th
percentile stays under 20 ms. At 50 req/s it jumps to 907 ms, and at 100 req/s to 17.8 s. The cause is
CPU: Juice Shop runs as a single Node.js process, and at about 45 req/s of search its main thread is
fully busy, so new requests queue.</p>
<p><b>Past that point, Juice Shop doesn't recover cleanly.</b> Memory grows from about 250 MB to 2.5-3 GB
while requests queue, and stays there after the load stops. A single search then takes about 80-130 ms
instead of 42-48 ms until the process is restarted.</p>
<p>One functional defect also turned up: adding a product that is already in the basket returns
<b>HTTP 500</b> instead of a 4xx error.</p>`,

  approach: `
<table><tbody>
<tr><th>Application</th><td>OWASP Juice Shop v20.3.0: an open-source Angular + Node.js (Express) e-commerce app with a SQLite
database. Default configuration, one Node.js process.</td></tr>
<tr><th>Modules</th><td><b>Product Search</b> (catalogue search and product details, anonymous), <b>Login</b> (authentication and
profile), <b>Basket</b> (view, add, change quantity, remove; logged in). Each is tested on its own so results can be attributed to it.</td></tr>
<tr><th>Tool</th><td>k6 v2.3.0. Scripts are JavaScript, pass/fail limits are thresholds that set the exit code, and the
arrival-rate executor makes a fair stress test. See <code>docs/tool-selection.md</code>.</td></tr>
<tr><th>Test types</th><td><b>Smoke</b>: 1 user, 1 pass, to prove the scripts work. <b>Load</b>: per module, ramp up 1 min, hold
3 min, ramp down 30 s. <b>Stress</b>: search at a rising fixed request rate, 1 min per step, to find the breaking point.</td></tr>
<tr><th>Realistic traffic</th><td>Think time of 1-3 s between actions, a mix of request types per module (for example 70% searches that
find products, 10% that find nothing, 20% product pages), varied search terms, and one account per virtual user so sessions and
baskets are never shared. Test accounts are created in <code>setup()</code>, before the load starts, so registration isn't measured.</td></tr>
<tr><th>Assertions</th><td>Every response is checked for content, not only status (a search returns products, the basket contains the added
item, a wrong password gets 401). Thresholds per request type: p95 &lt; 500 ms for reads, &lt; 800 ms for login and basket writes,
&lt; 1% failed requests, &gt; 99% checks passed.</td></tr>
<tr><th>Environment</th><td>Laptop with an Intel Core i5-1235U (10 cores / 12 threads), 39.7 GB RAM and an NVMe SSD, on Windows 11 Pro.
Node.js v24.21.0. k6 and Juice Shop on the same machine, over loopback (no network latency).</td></tr>
<tr><th>Monitoring</th><td>k6 records response time, throughput, errors and checks, with an HTML dashboard per test. <code>run.ps1</code>
samples Juice Shop's CPU (100% = one full core) and memory every 2 s.</td></tr>
</tbody></table>`,

  modules: {
    'product-search': `
<p><b>Passes with a wide margin.</b> Every request type is at least 6x inside its 500 ms limit, with no failed requests across
5,572 requests at 50 concurrent users. All 11,142 checks passed, so every search returned products and every empty search returned an empty list.</p>
<ul>
<li><b>Product details is the slowest request</b> (p95 81 ms, against 50 ms for a search), although it returns a single product.
It is served by Juice Shop's generic REST API (<code>/api/Products/&lt;id&gt;</code>) rather than the hand-written search route, so
the generic layer appears to cost more per request than the query itself.</li>
<li><b>A few outliers of 1.4-2.0 s</b> (the max column) don't affect the p95. They are isolated and fit a pause such as garbage
collection, but this test can't confirm the cause.</li>
<li>Searches that find nothing cost the same as ones that do, which is consistent with the time going on per-request overhead rather than on result size.</li>
</ul>`,
    login: `
<p><b>Passes with a wide margin.</b> Login p95 is 88 ms against an 800 ms limit, and the profile lookup is 6 ms. All 9,002 checks passed:
every successful login returned a token, and that token identified the right user.</p>
<ul>
<li><b>A rejected login costs as much as a successful one</b> (p95 85 ms against 88 ms). So most of the time goes on looking up the
account, not on issuing the token.</li>
<li><b>No protection against password guessing.</b> The test made 497 wrong-password attempts, about 16 per account in 4.5 minutes.
Every one was answered at full speed, with no lockout, delay or rate limit. This is a security gap rather than a performance one, but load
testing is where it shows (see finding 6).</li>
</ul>`,
    basket: `
<p><b>Passes with a wide margin.</b> The slowest action, changing the quantity, has a p95 of 158 ms against an 800 ms limit. All 6,636
checks passed, including that each added product appears in the basket, so 30 users writing at the same time didn't corrupt each other's baskets.</p>
<ul>
<li><b>Writes are about twice as slow as reads:</b> p95 158 ms to change a quantity and 127 ms to remove an item, against 76 ms to view the
basket. Updates and deletes go to SQLite, which allows one writer at a time, so they would be the first to suffer at higher load.</li>
<li><b>Memory stayed flat</b> (279-286 MB) for the whole test, because each user empties their basket at the end of every pass.</li>
</ul>`,
  },

  serverCpu: `
<p>At a similar 20-23 requests per second, each module keeps Juice Shop at <b>58-64% of one CPU core</b> under steady load. That is
roughly 25-30 ms of CPU per request on average, whichever module is used. All three modules share the same single process, so they also
share its limit. The stress test puts that limit at about 40-45 requests per second for search. Combined traffic across the whole
site should hit the same ceiling at a similar total rate, so the three load tests running at once (about 63 req/s) would already exceed it.
That last point is an estimate from these numbers, not a measured result.</p>`,

  stressIntro: `
<p>The stress test sends product searches at a fixed rate that rises every minute: 10, 20, 30, 40, 50, 60, 80 and 100
requests per second. k6 keeps sending at the target rate even when responses slow down (an open model), so a slow server
can't hide by slowing the test down. Requests time out after 30 s. Juice Shop was restarted before the run.</p>`,

  stressAnalysis: `
<p><b>Breaking point: between 40 and 50 requests per second.</b></p>
<ul>
<li><b>10-40 req/s: healthy.</b> Every request completes, the median is 7-11 ms and p95 16-18 ms. Server CPU rises with
the rate, from 36% to 92% of one core on average.</li>
<li><b>50 req/s: the knee.</b> CPU averages 109%, so the Node.js main thread is saturated (the extra comes from
garbage collection and I/O threads). Requests start to queue: the median is still 27 ms, but p95 is 907 ms and fails the target.</li>
<li><b>60-100 req/s: overloaded.</b> Queues grow every second. p95 rises to 3.2 s, then 13.9 s, then 17.8 s. Throughput
peaks at about 68 req/s and then <i>falls</i> to 61 req/s at a 100 req/s target, so more traffic gets less work done.
k6 also had to drop 3,030 requests it couldn't start because all 1,000 virtual users were waiting on responses.</li>
<li><b>No errors, only waiting.</b> Every request eventually succeeded within the 30 s timeout. A real user would have
given up long before.</li>
<li><b>Memory grows once requests queue.</b> It holds at about 245 MB up to 40 req/s, then climbs to 2.5 GB by the
end of the test. Each queued request holds memory until it is answered.</li>
</ul>
<p>So one Juice Shop process can serve about <b>40 searches per second within target</b>, roughly 23 ms of CPU per
search (92% of a core at 40 req/s). That is low for an endpoint that returns at most 35 small rows. Most of the time is
spent in the application's per-request work rather than in the database.</p>`,

  overloadIntro: `
<p>The first stress run used much bigger steps (50, 100, 200, 400, 600 and 800 requests per second), before the breaking
point was known. It overloaded the server from the first step, which is why the second run zooms in on 10-100 req/s. It is
kept because it shows how Juice Shop behaves well past its limit.</p>`,

  overloadAnalysis: `
<ul>
<li><b>Failure by timeout.</b> From 200 req/s, 13% of requests hit the 30 s timeout; from 400 req/s, all of them did. The server
never returned an error itself. It queued work without limit until clients gave up.</li>
<li><b>Memory grew to 3.1 GB and stayed there.</b> It was still 3.0 GB with no traffic, after the test. A single search then took
128 ms, against about 45 ms on a fresh process. The second stress run showed the same pattern (2.8 GB after 30 s idle, search 81 ms).</li>
<li>From this data alone we can't tell whether that memory is a leak or a heap that V8 doesn't hand back to the operating system.
The slower responses afterwards suggest the large heap costs garbage-collection time either way. A heap snapshot would settle it
(see Recommendations).</li>
</ul>`,

  bottlenecks: `
<table><thead><tr><th>#</th><th>Finding</th><th>Evidence</th><th>Impact</th></tr></thead><tbody>
<tr><td>1</td><td><b>CPU-bound single process.</b> Juice Shop runs all requests on one Node.js main thread.</td>
<td>Stress: CPU reaches 100% of a core at about 45 req/s of search, exactly where latency breaks.</td>
<td>Capacity is about 40 searches/s per process, whatever the hardware has spare. The other 9 cores sat mostly idle.</td></tr>
<tr><td>2</td><td><b>High CPU cost per request, in every module.</b></td>
<td>About 23 ms of CPU per search at 40 req/s in the stress test, and 58-64% of a core at only 20-23 req/s in each load test (25-30 ms per request).</td>
<td>The cost is spread across all routes, so the whole site shares a ceiling of roughly 40 req/s per process.</td></tr>
<tr><td>3</td><td><b>No load shedding.</b> Excess requests queue without limit instead of being rejected quickly.</td>
<td>Overload run: 0% server errors but 100% client timeouts from 400 req/s; throughput falls when overloaded.</td>
<td>One traffic spike makes the site unusable for everyone, rather than slow for a few.</td></tr>
<tr><td>4</td><td><b>Memory retained after overload.</b></td>
<td>Memory grows from about 250 MB to 2.5-3.1 GB during overload, stays there when traffic stops, and responses stay about 2x slower.</td>
<td>The app doesn't recover after a spike without a restart, and could run out of memory under a longer one.</td></tr>
<tr><td>5</td><td><b>HTTP 500 on a duplicate basket item</b> (functional defect).</td>
<td>Adding a product that is already in the basket returns 500. Found while designing the basket test.</td>
<td>A server error for a normal user action. It also counts as an error in monitoring.</td></tr>
<tr><td>6</td><td><b>No rate limit on failed logins</b> (security).</td>
<td>The login test made 497 wrong-password attempts (about 16 per account in 4.5 min), all answered in under 230 ms with no lockout.</td>
<td>Passwords can be guessed at full server speed. Login is also an obvious target for a request flood, given finding 1.</td></tr>
</tbody></table>`,

  recommendations: `
<ol>
<li><b>Run several Node.js processes.</b> Use Node's <code>cluster</code> module or a process manager such as PM2, one process per core,
behind a load balancer. Read-heavy endpoints like search should scale close to linearly. Writes to SQLite are serialised, so
for production traffic move the database to PostgreSQL or MySQL as well.</li>
<li><b>Profile and cache search.</b> Profile the search route with <code>node --cpu-prof</code> to find where the 23 ms of CPU goes. The
catalogue is small and rarely changes, so cache search results in memory with a short expiry. That should remove most of the cost.</li>
<li><b>Shed load instead of queueing.</b> Cap concurrent requests per process and answer the excess quickly with 503 and
<code>Retry-After</code>, and set a server-side request timeout. Users then get a fast error instead of a 30 s wait, and memory stays bounded.</li>
<li><b>Investigate the retained memory.</b> Take heap snapshots before, during and after an overload run (for example with
<code>node --inspect</code> and Chrome DevTools) to see whether it is a leak. In the meantime, a health check that restarts a process
whose memory stays high would contain the damage.</li>
<li><b>Fix the duplicate basket item error.</b> Return 400 or 409, or increase the quantity of the existing item instead.</li>
<li><b>Rate-limit failed logins</b> per account and per IP address (for example, slow down after 5 failures). This also protects the CPU budget from finding 1.</li>
<li><b>Re-test on production-like infrastructure.</b> Put the load generator on a separate machine, run a soak test of an hour or more at
about 30 searches per second to confirm memory stays flat below the limit, and repeat the stress test after each change above to
measure the gain.</li>
</ol>`,

  limitations: `
<table><thead><tr><th>Limitation</th><th>Effect</th><th>Workaround or mitigation</th></tr></thead><tbody>
<tr><td>k6 and Juice Shop on the same laptop</td><td>They compete for CPU. Under stress, k6 runs up to 1,000 virtual users,
which takes CPU the app could have used.</td><td>The app is limited to about one core anyway (finding 1), and the laptop has 12 threads,
so the effect on the breaking point should be small. For final numbers, run k6 from a separate machine.</td></tr>
<tr><td>Laptop CPU (i5-1235U, a low-power U-series chip)</td><td>Clock speed varies with temperature and power settings, so absolute
numbers will differ on servers.</td><td>Compare results against each other on this machine, and treat absolute capacity as indicative.</td></tr>
<tr><td>Loopback network</td><td>No real network latency, bandwidth or TLS, so response times are server time only.</td>
<td>This isolates server performance, which is the goal. Add network latency when testing a deployed environment.</td></tr>
<tr><td>Juice Shop is a deliberately insecure training app</td><td>It isn't tuned for production (SQLite, a single process,
challenge-tracking code on every request).</td><td>The findings describe this app as shipped. The recommendations explain what production deployment would change.</td></tr>
<tr><td>Short tests (4.5-8 min)</td><td>Slow leaks or degradation over hours wouldn't show up.</td><td>Recommendation 6: a soak test of an hour or more.</td></tr>
<tr><td>Server metrics are process-level, sampled every 2 s</td><td>They show CPU and the Windows working set, not the V8 heap or event-loop delay.</td>
<td>Enough to locate the bottleneck. Recommendations 2 and 4 cover deeper profiling.</td></tr>
<tr><td>The first run's CPU sampler interfered with the tests</td><td>It ran a system-wide CPU query every 2 s, which cost CPU itself and stretched
its sampling interval to about 3 s, so its raw CPU figures were too high.</td><td>CPU was recalculated from the real sample times, the sampler was replaced
with a lighter one built into <code>run.ps1</code>, and the three load tests were run again on a freshly started Juice Shop. The report
uses the rerun's results. The difference was large: p95 for search fell from 154 ms to 50 ms, and for login from 326 ms to 88 ms. The first
run is kept in <code>results/2026-10-27_12-47-01</code> as evidence.</td></tr>
<tr><td>Permission prompts blocked starting Juice Shop from the automation at first</td><td>The first runs needed Juice Shop started by hand.</td>
<td><code>run.ps1</code> now starts and stops Juice Shop itself when it isn't running.</td></tr>
</tbody></table>`,

  reproduce: `
<p>From a fresh clone on Windows, <code>.\\run.ps1 all</code> downloads Node.js, Juice Shop and k6, starts Juice Shop, runs every test, and
saves the results to <code>results\\&lt;run&gt;\\</code>. Each test can also be run alone, for example <code>.\\run.ps1 stress</code>.
Then <code>node docs\\report\\build-report.js</code> rebuilds this report from the newest results. See the README for details.</p>`,
};
