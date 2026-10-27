// Helpers shared by every test script.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
export const JSON_HEADERS = { 'Content-Type': 'application/json' };
export const PASSWORD = 'Passw0rd!';

export function authHeaders(token) {
  return { ...JSON_HEADERS, Authorization: `Bearer ${token}` };
}

// Registers `count` fresh users and returns their credentials. Called from setup(),
// so the accounts exist before load starts and registration isn't part of the measurement.
export function createUsers(count, prefix) {
  const runId = Date.now();
  const requests = [];
  for (let i = 0; i < count; i++) {
    const email = `${prefix}_${runId}_${i}@test.local`;
    requests.push(['POST', `${BASE_URL}/api/Users`, JSON.stringify({
      email,
      password: PASSWORD,
      passwordRepeat: PASSWORD,
      securityQuestion: { id: 1 },
      securityAnswer: 'perf',
    }), { headers: JSON_HEADERS, tags: { name: 'setup: register' } }]);
  }
  const responses = http.batch(requests);
  const users = [];
  responses.forEach((res, i) => {
    if (check(res, { 'setup register: status 201': (r) => r.status === 201 })) {
      users.push({ email: JSON.parse(requests[i][2]).email, password: PASSWORD });
    }
  });
  if (users.length < count) {
    throw new Error(`Only ${users.length} of ${count} test users could be registered`);
  }
  return users;
}

export function login(user, tags = { name: 'login' }) {
  return http.post(`${BASE_URL}/rest/user/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: JSON_HEADERS, tags });
}

// Random pause that stands in for a real user reading the page.
export function thinkTime(min = 1, max = 3) {
  sleep(min + Math.random() * (max - min));
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}
