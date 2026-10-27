// Load test: Basket module.
// 30 logged-in shoppers each work on their own basket: view it, add a product,
// change the quantity, view it again and remove the product.
import http from 'k6/http';
import { check, fail } from 'k6';
import { BASE_URL, createUsers, login, authHeaders, thinkTime, pick } from './lib/common.js';

const MAX_VUS = 30;

export const options = {
  scenarios: {
    basket: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: MAX_VUS },  // ramp-up
        { duration: '3m', target: MAX_VUS },  // steady load
        { duration: '30s', target: 0 },       // ramp-down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'http_req_duration{name:basket view}': ['p(95)<800'],
    'http_req_duration{name:basket add}': ['p(95)<800'],
    'http_req_duration{name:basket update}': ['p(95)<800'],
    'http_req_duration{name:basket remove}': ['p(95)<800'],
  },
};

export function setup() {
  // Only use products that are in stock and allow at least 2 per customer,
  // so every add and quantity change is valid.
  const listed = http.get(`${BASE_URL}/rest/products/search?q=`, { tags: { name: 'setup: product list' } })
    .json('data').map((p) => p.id);
  const stock = http.get(`${BASE_URL}/api/Quantitys`, { tags: { name: 'setup: stock' } }).json('data');
  const productIds = stock
    .filter((q) => listed.includes(q.ProductId) && q.quantity >= 10 && (q.limitPerUser === null || q.limitPerUser >= 2))
    .map((q) => q.ProductId);
  if (productIds.length === 0) throw new Error('No products available for basket tests');

  // One user per virtual user, so no two virtual users share a basket.
  return { users: createUsers(MAX_VUS, 'basket'), productIds };
}

// Logged in once per virtual user and reused, like a real browser session.
let session = null;

export default function (data) {
  if (!session) {
    const res = login(data.users[(__VU - 1) % data.users.length]);
    if (!check(res, { 'login: status 200': (r) => r.status === 200 })) fail('login failed');
    session = { headers: authHeaders(res.json('authentication.token')), basketId: res.json('authentication.bid') };
  }
  const { headers, basketId } = session;

  // Workload per iteration: 2 views, 1 add, 1 update, 1 remove (40/20/20/20%).
  const view = http.get(`${BASE_URL}/rest/basket/${basketId}`, { headers, tags: { name: 'basket view' } });
  check(view, { 'basket view: status 200': (r) => r.status === 200 });
  thinkTime(1, 2);

  const productId = pick(data.productIds);
  const add = http.post(`${BASE_URL}/api/BasketItems`,
    JSON.stringify({ ProductId: productId, BasketId: `${basketId}`, quantity: 1 }),
    { headers, tags: { name: 'basket add' } });
  if (!check(add, { 'basket add: status 200': (r) => r.status === 200 })) return;
  const itemId = add.json('data.id');
  thinkTime(1, 2);

  const update = http.put(`${BASE_URL}/api/BasketItems/${itemId}`, JSON.stringify({ quantity: 2 }),
    { headers, tags: { name: 'basket update' } });
  check(update, {
    'basket update: status 200': (r) => r.status === 200,
    'basket update: quantity is 2': (r) => r.json('data.quantity') === 2,
  });

  const viewAgain = http.get(`${BASE_URL}/rest/basket/${basketId}`, { headers, tags: { name: 'basket view' } });
  check(viewAgain, {
    'basket view: contains the product': (r) => r.json('data.Products').some((p) => p.id === productId),
  });
  thinkTime(1, 2);

  const remove = http.del(`${BASE_URL}/api/BasketItems/${itemId}`, null, { headers, tags: { name: 'basket remove' } });
  check(remove, { 'basket remove: status 200': (r) => r.status === 200 });
  thinkTime(1, 2);
}
