import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const BOOKINGS_FILE = join(DATA_DIR, 'bookings.json');
const TRANSACTIONS_FILE = join(DATA_DIR, 'transactions.json');
const SERVICES_FILE = join(ROOT, 'services.json');
const PORT = Number(process.env.PORT || 4173);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'ADMIN';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin123!';
const sessions = new Map();
const loginFailures = new Map();
let writeQueue = Promise.resolve();

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  console.warn('Using default admin credentials ADMIN / Admin123!. Set ADMIN_USERNAME and ADMIN_PASSWORD before deployment.');
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16384) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON body.'), { status: 400 });
  }
}

async function readServices() {
  return JSON.parse(await readFile(SERVICES_FILE, 'utf8'));
}

async function readBookings() {
  try {
    return JSON.parse(await readFile(BOOKINGS_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readTransactions() {
  try {
    return JSON.parse(await readFile(TRANSACTIONS_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function updateBookings(update) {
  const operation = writeQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const bookings = await readBookings();
    const result = update(bookings);
    const temporaryFile = `${BOOKINGS_FILE}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(bookings, null, 2)}\n`, 'utf8');
    await rename(temporaryFile, BOOKINGS_FILE);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function updateTransactions(update) {
  const operation = writeQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const transactions = await readTransactions();
    const result = update(transactions);
    const temporaryFile = `${TRANSACTIONS_FILE}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(transactions, null, 2)}\n`, 'utf8');
    await rename(temporaryFile, TRANSACTIONS_FILE);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function getSession(request) {
  const cookie = request.headers.cookie || '';
  const token = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('ff_admin='))?.slice('ff_admin='.length);
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return token;
}

function requireAdmin(request, response) {
  if (getSession(request)) return true;
  sendJson(response, 401, { error: 'Please sign in to access the admin dashboard.' });
  return false;
}

function credentialMatches(candidate, expectedValue) {
  const expectedHash = createHash('sha256').update(expectedValue).digest();
  const candidateHash = createHash('sha256').update(String(candidate || '')).digest();
  return timingSafeEqual(expectedHash, candidateHash);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value && value >= new Date().toISOString().slice(0, 10);
}

async function servePage(response, page) {
  try {
    const content = await readFile(join(ROOT, page));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    response.end(content);
  } catch {
    sendJson(response, 500, { error: 'The page could not be loaded.' });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (request.method === 'GET' && pathname === '/api/services') {
      sendJson(response, 200, await readServices());
      return;
    }

    if (request.method === 'POST' && pathname === '/api/bookings') {
      const body = await readJsonBody(request);
      const services = await readServices();
      const service = services.find(item => item.slug === body.service);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const stylist = typeof body.stylist === 'string' ? body.stylist.trim() : 'No preference';
      const time = typeof body.time === 'string' ? body.time.trim() : '';
      const notes = typeof body.notes === 'string' ? body.notes.trim() : '';

      if (!name || name.length > 100) {
        sendJson(response, 400, { error: 'Enter a name of 1 to 100 characters.' });
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        sendJson(response, 400, { error: 'Enter a valid email address.' });
        return;
      }
      if (!service || !validDate(body.date) || !time || time.length > 80 || stylist.length > 100 || notes.length > 1000) {
        sendJson(response, 400, { error: 'Choose a valid service, future date, and preferred time.' });
        return;
      }

      const booking = {
        id: randomUUID(),
        name,
        email,
        service: service.slug,
        serviceName: service.name,
        category: service.category,
        price: service.price,
        stylist: stylist || 'No preference',
        date: body.date,
        time,
        notes,
        status: 'pending',
        createdAt: new Date().toISOString()
      };
      await updateBookings(bookings => bookings.push(booking));
      sendJson(response, 201, { booking: { id: booking.id, service: booking.serviceName, date: booking.date, status: booking.status } });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/admin/login') {
      const forwardedFor = request.socket.remoteAddress || 'local';
      const failure = loginFailures.get(forwardedFor);
      if (failure?.lockedUntil > Date.now()) {
        sendJson(response, 429, { error: 'Too many attempts. Try again in a few minutes.' });
        return;
      }
      const body = await readJsonBody(request);
      const usernameMatches = credentialMatches(body.username, ADMIN_USERNAME);
      const passwordMatches = credentialMatches(body.password, ADMIN_PASSWORD);
      if (!usernameMatches || !passwordMatches) {
        const attempts = (failure?.attempts || 0) + 1;
        loginFailures.set(forwardedFor, { attempts, lockedUntil: attempts >= 5 ? Date.now() + 5 * 60 * 1000 : 0 });
        sendJson(response, 401, { error: 'That password did not match.' });
        return;
      }
      loginFailures.delete(forwardedFor);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': `ff_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}` });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/admin/logout') {
      const token = getSession(request);
      if (token) sessions.delete(token);
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': 'ff_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/admin/session') {
      sendJson(response, 200, { authenticated: Boolean(getSession(request)) });
      return;
    }

    if (pathname === '/api/admin/bookings' && request.method === 'GET') {
      if (!requireAdmin(request, response)) return;
      const bookings = await readBookings();
      bookings.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      sendJson(response, 200, bookings);
      return;
    }

    if (pathname === '/api/admin/transactions' && request.method === 'GET') {
      if (!requireAdmin(request, response)) return;
      const transactions = await readTransactions();
      transactions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const totals = transactions.reduce((summary, transaction) => {
        summary[transaction.type] += transaction.amount;
        return summary;
      }, { collected: 0, debt: 0, credit: 0 });
      sendJson(response, 200, { transactions, totals });
      return;
    }

    if (pathname === '/api/admin/transactions' && request.method === 'POST') {
      if (!requireAdmin(request, response)) return;
      const body = await readJsonBody(request);
      const allowedTypes = new Set(['collected', 'debt', 'credit']);
      const amount = Number(body.amount);
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      const customer = typeof body.customer === 'string' ? body.customer.trim() : '';
      if (!allowedTypes.has(body.type) || !Number.isFinite(amount) || amount <= 0 || amount > 10000000 || !description || description.length > 200 || customer.length > 120) {
        sendJson(response, 400, { error: 'Enter a valid type, amount, description, and optional customer.' });
        return;
      }
      const transaction = {
        id: randomUUID(),
        type: body.type,
        amount: Math.round(amount * 100) / 100,
        description,
        customer,
        createdAt: new Date().toISOString()
      };
      await updateTransactions(transactions => transactions.push(transaction));
      sendJson(response, 201, transaction);
      return;
    }

    const bookingStatusMatch = pathname.match(/^\/api\/admin\/bookings\/([0-9a-f-]+)$/i);
    if (bookingStatusMatch && request.method === 'PATCH') {
      if (!requireAdmin(request, response)) return;
      const body = await readJsonBody(request);
      const allowedStatuses = new Set(['pending', 'confirmed', 'completed', 'cancelled']);
      if (!allowedStatuses.has(body.status)) {
        sendJson(response, 400, { error: 'Choose a valid booking status.' });
        return;
      }
      const updatedBooking = await updateBookings(bookings => {
        const booking = bookings.find(item => item.id === bookingStatusMatch[1]);
        if (booking) booking.status = body.status;
        return booking || null;
      });
      if (!updatedBooking) {
        sendJson(response, 404, { error: 'Booking not found.' });
        return;
      }
      sendJson(response, 200, updatedBooking);
      return;
    }

    if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      await servePage(response, 'index.html');
      return;
    }
    if (request.method === 'GET' && pathname === '/services.html') {
      await servePage(response, 'services.html');
      return;
    }
    if (request.method === 'GET' && pathname === '/service.html') {
      await servePage(response, 'service.html');
      return;
    }
    if (request.method === 'GET' && pathname === '/admin') {
      response.writeHead(302, { Location: '/admin.html' });
      response.end();
      return;
    }
    if (request.method === 'GET' && pathname === '/admin.html') {
      await servePage(response, 'admin.html');
      return;
    }

    sendJson(response, 404, { error: 'Page or endpoint not found.' });
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' });
    else response.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`FORM & FADE is running at http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
});
