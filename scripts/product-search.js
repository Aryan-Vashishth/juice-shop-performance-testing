// Load test: Product search module.
// 50 anonymous shoppers browse the catalogue: keyword searches that find products,
// searches that find nothing, and opening a product's details.
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { BASE_URL, thinkTime, pick } from './lib/common.js';

// Loaded once and shared by all virtual users instead of copied into each one.
const hits = new SharedArray('search hits', () => JSON.parse(open('../data/search-terms.json')).hits);
const misses = new SharedArray('search misses', () => JSON.parse(open('../data/search-terms.json')).misses);

export const options = {
  scenarios: {
    product_search: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 50 },  // ramp-up
        { duration: '3m', target: 50 },  // steady load
        { duration: '30s', target: 0 },  // ramp-down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'http_req_duration{name:search}': ['p(95)<500'],
    'http_req_duration{name:search (no match)}': ['p(95)<500'],
    'http_req_duration{name:product details}': ['p(95)<500'],
  },
};

export function setup() {
  const res = http.get(`${BASE_URL}/rest/products/search?q=`, { tags: { name: 'setup: product list' } });
  const ids = res.json('data').map((p) => p.id);
  if (ids.length === 0) throw new Error('No products found; is Juice Shop running?');
  return { productIds: ids };
}

// Workload distribution per iteration: 70% keyword search, 10% search with no
// results, 20% product details.
export default function (data) {
  const roll = Math.random();

  if (roll < 0.7) {
    const res = http.get(`${BASE_URL}/rest/products/search?q=${encodeURIComponent(pick(hits))}`,
      { tags: { name: 'search' } });
    check(res, {
      'search: status 200': (r) => r.status === 200,
      'search: returns products': (r) => r.json('data').length > 0,
    });
  } else if (roll < 0.8) {
    const res = http.get(`${BASE_URL}/rest/products/search?q=${encodeURIComponent(pick(misses))}`,
      { tags: { name: 'search (no match)' } });
    check(res, {
      'search (no match): status 200': (r) => r.status === 200,
      'search (no match): returns empty list': (r) => r.json('data').length === 0,
    });
  } else {
    const id = pick(data.productIds);
    const res = http.get(`${BASE_URL}/api/Products/${id}`, { tags: { name: 'product details' } });
    check(res, {
      'product details: status 200': (r) => r.status === 200,
      'product details: correct product': (r) => r.json('data.id') === id,
    });
  }

  thinkTime(1, 3);
}
