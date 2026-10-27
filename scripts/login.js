// Load test: Login module.
// 30 registered users sign in repeatedly. Most sign in successfully and load their
// profile; some mistype their password and must be rejected.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, createUsers, login, thinkTime } from './lib/common.js';

const MAX_VUS = 30;

export const options = {
  scenarios: {
    login: {
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
    'http_req_duration{name:login}': ['p(95)<800'],
    'http_req_duration{name:login (wrong password)}': ['p(95)<800'],
    'http_req_duration{name:whoami}': ['p(95)<500'],
  },
};

export function setup() {
  return { users: createUsers(MAX_VUS, 'login') };
}

// Workload distribution per iteration: 85% successful login followed by a profile
// lookup, 15% login with a wrong password.
export default function (data) {
  const user = data.users[(__VU - 1) % data.users.length];

  if (Math.random() < 0.85) {
    const res = login(user);
    const ok = check(res, {
      'login: status 200': (r) => r.status === 200,
      'login: returns token': (r) => !!r.json('authentication.token'),
    });
    if (ok) {
      // whoami reads the token from the `token` cookie, as the browser app sends it.
      const me = http.get(`${BASE_URL}/rest/user/whoami`,
        { cookies: { token: res.json('authentication.token') }, tags: { name: 'whoami' } });
      check(me, { 'whoami: returns the logged-in user': (r) => r.json('user.email') === user.email });
    }
  } else {
    // 401 is the correct answer here, so don't count it as a failed request.
    const res = http.post(`${BASE_URL}/rest/user/login`,
      JSON.stringify({ email: user.email, password: 'wrong-password' }),
      {
        headers: { 'Content-Type': 'application/json' },
        tags: { name: 'login (wrong password)' },
        responseCallback: http.expectedStatuses(401),
      });
    check(res, { 'login (wrong password): status 401': (r) => r.status === 401 });
  }

  thinkTime(1, 3);
}
