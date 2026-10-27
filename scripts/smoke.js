// Smoke test: 1 virtual user, 1 pass through every module.
// Purpose: prove the scripts and the app work before applying real load.
import http from 'k6/http';
import { check, group } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    http_req_failed: ['rate==0'],      // no request may fail
    checks: ['rate==1'],               // every check must pass
    http_req_duration: ['p(95)<1000'], // generous limit; this is a sanity run
  },
};

// Runs once before the test: create a fresh user so the run is repeatable.
export function setup() {
  const email = `smoke_${Date.now()}@test.local`;
  const password = 'Passw0rd!';
  const res = http.post(`${BASE_URL}/api/Users`, JSON.stringify({
    email,
    password,
    passwordRepeat: password,
    securityQuestion: { id: 1 },
    securityAnswer: 'smoke',
  }), { headers: JSON_HEADERS });
  check(res, { 'register: status 201': (r) => r.status === 201 });
  return { email, password };
}

export default function (user) {
  group('Product search', () => {
    const res = http.get(`${BASE_URL}/rest/products/search?q=apple`);
    check(res, {
      'search: status 200': (r) => r.status === 200,
      'search: returns products': (r) => r.json('data').length > 0,
    });
  });

  let token;
  let basketId;
  group('Login', () => {
    const res = http.post(`${BASE_URL}/rest/user/login`,
      JSON.stringify({ email: user.email, password: user.password }),
      { headers: JSON_HEADERS });
    check(res, {
      'login: status 200': (r) => r.status === 200,
      'login: returns token': (r) => !!r.json('authentication.token'),
    });
    token = res.json('authentication.token');
    basketId = res.json('authentication.bid');
  });

  group('Basket', () => {
    const authHeaders = { ...JSON_HEADERS, Authorization: `Bearer ${token}` };

    const add = http.post(`${BASE_URL}/api/BasketItems`,
      JSON.stringify({ ProductId: 1, BasketId: `${basketId}`, quantity: 1 }),
      { headers: authHeaders });
    check(add, { 'basket add: status 200': (r) => r.status === 200 });

    const view = http.get(`${BASE_URL}/rest/basket/${basketId}`, { headers: authHeaders });
    check(view, {
      'basket view: status 200': (r) => r.status === 200,
      'basket view: has 1 item': (r) => r.json('data.Products').length === 1,
    });
  });
}
