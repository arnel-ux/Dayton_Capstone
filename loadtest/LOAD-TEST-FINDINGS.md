# Performance and Load Testing Results: cqacapstone.me

## 1. Objective
Measure how the cqacapstone.me web system responds under increasing numbers of concurrent users, and find the load at which its performance degrades.

## 2. Test Setup
- **Tool:** Apache JMeter 5.6.3, run in non-GUI (command-line) mode.
- **Target:** https://cqacapstone.me, hosted on an Azure virtual machine (cqacapstone-us).
- **Test plan:** `loadtest/cqacapstone-loadtest.jmx`. Each virtual user repeatedly requests five public pages (`/`, `/login`, `/client-login`, `/survey-offline`, `/api/health`) with a 2-second pause between requests.
- **Scope:** Only public, read-only pages were tested. Login and survey submission were excluded so that no data was written to the database.
- **Server monitoring:** Azure Monitor, Percentage CPU metric.
- **Load generator:** a single laptop on one internet connection, used for all runs.
- **Test type by run:** the 5-user run is the performance (baseline) test. The 25, 50, 100, 150 and 200-user runs are the load tests, with 200 users acting as a stress level.

## 3. Results

| Run | Users | Requests | Error % | Avg (ms) | Median (ms) | 95th pct (ms) | Max (ms) | Throughput (req/s) | Peak server CPU |
|---|---|---|---|---|---|---|---|---|---|
| Baseline | 5 | 248 | 0% | 317 | 201 | 895 | 1580 | 2.1 | not measured |
| Load | 25 | 1779 | 0% | 313 | 206 | 940 | 3097 | 10.0 | about 4-5% |
| Load | 50 | 3254 | 0% | 299 | 199 | 882 | 2355 | 18.2 | 6.79% |
| Load | 100 | 5393 | 0% | 498 | 204 | 2382 | 4265 | 30.0 | 11.685% |
| Load | 150 | 5721 | 0% | 1188 | 197 | 8743 | 9285 | 31.0 | 12.1% |
| Load | 200 | 5925 | 0% | 1681 | 197 | 13263 | 15968 | 31.2 | 12.175% |

Throughput is averaged over each whole run, including ramp-up and the final drain, so it is lower than the steady-state rate of about 38-41 requests/s seen in the 100, 150 and 200-user runs.

Per-page average response time (ms):

| Page | 100 users | 200 users |
|---|---|---|
| `/survey-offline` | 1787 | 7704 |
| `/` | 317 | 289 |
| `/login` | 227 | 201 |
| `/client-login` | 82 | 71 |
| `/api/health` | 85 | 79 |

## 4. Findings
1. **No failures.** Every run completed with 0% errors, and the VM stayed available throughout, even at 200 concurrent users.
2. **Stable up to 50 users.** Average response time stayed at about 300 ms with no degradation.
3. **Practical capacity is about 100 concurrent users.** At 100 users the average was 498 ms, still acceptable. Beyond that, response times rose sharply (1.2 s at 150 users, 1.7 s at 200).
4. **Throughput ceiling of about 40 requests/s.** From about 100 users onward, steady-state throughput stopped growing, so additional users only added waiting time.
5. **Server CPU is not the bottleneck.** CPU peaked at about 12% in the 100 to 200-user runs while response times worsened, so the limit lies elsewhere.
6. **One page causes the slowdown.** The median stayed at about 200 ms in every run. Only `/survey-offline` degraded, from about 0.9 s at 25 users to 7.7 s on average at 200 users, while the other four pages stayed fast. From the data volume, this page appears to transfer roughly 350 KB per request, far more than the others.
7. **At 200 users the slowest responses took about 14-16 seconds**, which users would find unusable even though the requests technically succeeded.

## 5. Recommendations
- Investigate and reduce the size of `/survey-offline` (for example, compression or fewer inlined assets). The cause has not yet been confirmed.
- Enable response compression and static-asset caching on the server if they are not already on.
- Re-run the 100 to 200-user tests after any change, to confirm the improvement.

## 6. Limitations
- The test measures HTML page responses only. It does not download images, scripts or stylesheets, so real page-load times in a browser are somewhat longer.
- Results include the laptop's own network connection, which may limit throughput at high user counts. A second load-generating machine would separate the two.
- Authenticated actions (login, survey submission) and the AI endpoints were not tested.
- The CPU peak for the 25-user run was read from the graph, not from a tooltip.
