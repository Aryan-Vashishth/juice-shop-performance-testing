// Stress test: Product search, pushed past normal load to find where it breaks.
// The request rate rises in 1-minute steps from 10 to 100 requests per second.
// Each step's results are tagged so the summary shows response time and errors per step.
// Override the steps with RATES, e.g. k6 run -e RATES=50,100,200,400,600,800 scripts/stress.js
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { BASE_URL, pick } from './lib/common.js';

const hits = new SharedArray('search hits', () => JSON.parse(open('../data/search-terms.json')).hits);

// Requests per second, one step per minute. A first run at 50-800 req/s showed search
// already overloaded at 50, so the default steps zoom in on 10-100.
const RATES = (__ENV.RATES || '10,20,30,40,50,60,80,100').split(',').map(Number);
const STEP_SECONDS = 60;

const stages = [];
RATES.forEach((rate) => {
  stages.push({ duration: '5s', target: rate });                    // climb to the next rate
  stages.push({ duration: `${STEP_SECONDS - 5}s`, target: rate });  // hold it
});

// Per-step sub-metrics only appear in the summary if a threshold references them.
// These limits are deliberately unreachable: a stress test is meant to exceed normal
// limits, so the steps are measured here and judged in the report.
const thresholds = { http_req_failed: ['rate<1'] };
RATES.forEach((rate) => {
  thresholds[`http_req_duration{step:${rate}rps}`] = ['p(95)<600000'];
  thresholds[`http_req_failed{step:${rate}rps}`] = ['rate<=1'];
  thresholds[`http_reqs{step:${rate}rps}`] = ['count>=0'];
});

export const options = {
  scenarios: {
    search_stress: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 1000,
      stages,
    },
  },
  thresholds,
};

export default function () {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  const step = RATES[Math.min(Math.floor(elapsed / STEP_SECONDS), RATES.length - 1)];

  const res = http.get(`${BASE_URL}/rest/products/search?q=${encodeURIComponent(pick(hits))}`,
    { tags: { name: 'search', step: `${step}rps` }, timeout: '30s' });
  check(res, { 'search: status 200': (r) => r.status === 200 }, { step: `${step}rps` });
}
