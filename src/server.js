import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { DatabaseSync } from 'node:sqlite';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const uploadDir = path.join(dataDir, 'uploads');
const adminDir = path.join(root, 'public', 'admin');
fs.mkdirSync(uploadDir, { recursive: true });
const host = process.env.SUCHAT_HOST || '127.0.0.1';
const port = Number(process.env.SUCHAT_PORT || 8787);
const secret = process.env.SUCHAT_JWT_SECRET || 'suchat-local-development-secret';
const adminHandle = process.env.SUCHAT_ADMIN_HANDLE || 'admin';
const adminPassword = process.env.SUCHAT_ADMIN_PASSWORD || 'change-me';
const db = new DatabaseSync(path.join(dataDir, 'suchat.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS admins (id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password TEXT NOT NULL DEFAULT '', avatar_url TEXT, bio TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, last_seen_at TEXT);
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_name TEXT NOT NULL, platform TEXT NOT NULL, push_token TEXT, last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, glass_mode TEXT NOT NULL DEFAULT 'liquid_glass', performance_profile TEXT NOT NULL DEFAULT 'full', page_transition TEXT NOT NULL DEFAULT 'shared_element', theme_mode TEXT NOT NULL DEFAULT 'system', reduced_motion INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, contact_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, alias TEXT, status TEXT NOT NULL DEFAULT 'accepted', created_at TEXT NOT NULL, UNIQUE(user_id, contact_user_id));
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'direct', title TEXT, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_members (conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'member', last_read_at TEXT, joined_at TEXT NOT NULL, PRIMARY KEY(conversation_id, user_id));
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sender_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL DEFAULT '', content_type TEXT NOT NULL DEFAULT 'text', attachment_id TEXT, created_at TEXT NOT NULL, edited_at TEXT, deleted_at TEXT);
CREATE TABLE IF NOT EXISTS moments (id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'contacts', created_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE IF NOT EXISTS moment_media (id TEXT PRIMARY KEY, moment_id TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE, upload_id TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS bottles (id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'drifting', picked_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, picked_at TEXT);
CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, file_name TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL DEFAULT 0, storage_key TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, data_json TEXT, read_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, target_type TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, details TEXT, status TEXT NOT NULL DEFAULT 'open', reviewed_by TEXT REFERENCES admins(id), reviewed_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at);
`);
// Supports databases created by the initial server revision.
try { db.exec("ALTER TABLE users ADD COLUMN password TEXT NOT NULL DEFAULT ''"); } catch {}
const now = () => new Date().toISOString();
const makeId = (prefix) => prefix + '_' + randomUUID();
const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);
if (!one('SELECT id FROM admins WHERE handle = ?', adminHandle)) run('INSERT INTO admins (id,handle,password,role,created_at) VALUES (?,?,?,?,?)', makeId('adm'), adminHandle, adminPassword, 'owner', now());

const app = Fastify({ logger: false });
// Preserve raw binary bodies for upload content while Fastify keeps its JSON parser.
app.addContentTypeParser(/.*/, { parseAs: 'buffer' }, (_, body, done) => done(null, body));
await app.register(cookie);
await app.register(fastifyStatic, { root: adminDir, prefix: '/admin/' });
await app.register(websocket);
const socketsByUser = new Map();
const publish = (userIds, event, data) => {
  for (const userId of userIds) {
    for (const socket of socketsByUser.get(userId) || []) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ event, data }));
    }
  }
};
app.addHook('onRequest', async (request, reply) => { reply.header('Access-Control-Allow-Origin', request.headers.origin || '*'); reply.header('Access-Control-Allow-Credentials', 'true'); reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization'); });
app.options('*', async (_, reply) => reply.code(204).send());
const tokenFrom = (request) => request.headers.authorization?.replace(/^Bearer\s+/i, '');
const userSession = (request) => { try { const token = tokenFrom(request); return token ? jwt.verify(token, secret) : null; } catch { return null; } };
const auth = async (request, reply) => { const session = userSession(request); if (!session || session.kind !== 'user') return reply.code(401).send({ error: 'auth_required' }); request.user = session; };
const adminGuard = async (request, reply) => { try { const token = request.cookies.suchat_admin_session || tokenFrom(request); const admin = jwt.verify(token, secret); if (admin.kind !== 'admin') throw new Error('not_admin'); request.admin = admin; } catch { return reply.code(401).send({ error: 'admin_auth_required' }); } };
const publicUser = (u) => u && ({ id: u.id, handle: u.handle, displayName: u.displayName ?? u.display_name, avatarUrl: u.avatarUrl ?? u.avatar_url ?? null, bio: u.bio ?? null, status: u.status, createdAt: u.createdAt ?? u.created_at, lastSeenAt: u.lastSeenAt ?? u.last_seen_at ?? null });
const requireBody = (reply, value, error) => value ? null : reply.code(400).send({ error });
const isMember = (conversationId, userId) => one('SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?', conversationId, userId);
const uploadsBytes = () => all('SELECT byte_size FROM uploads').reduce((total, row) => total + row.byte_size, 0);

app.get('/ws', { websocket: true }, (socket, request) => {
  const token = request.query?.access_token || tokenFrom(request);
  try {
    const session = jwt.verify(token, secret);
    if (session.kind !== 'user') throw new Error('not_user');
    const userSockets = socketsByUser.get(session.sub) || new Set();
    userSockets.add(socket);
    socketsByUser.set(session.sub, userSockets);
    socket.send(JSON.stringify({ event: 'connected', data: { userId: session.sub, time: now() } }));
    socket.on('close', () => { userSockets.delete(socket); if (userSockets.size === 0) socketsByUser.delete(session.sub); });
  } catch { socket.close(1008, 'auth_required'); }
});
app.get('/api/v1/health', async () => ({ status: 'ok', service: 'suchat-server-local', version: '0.2.0', time: now(), database: 'ready' }));
app.get('/api/v1/meta', async () => ({ name: 'Suchat Local Server', apiVersion: 'v1', websocketUrl: 'ws://' + host + ':' + port + '/ws', features: { moments: true, driftBottles: true, localUpload: true, adminWeb: true } }));
app.post('/api/v1/auth/register', async (request, reply) => { const b = request.body || {}; if (requireBody(reply, b.handle && b.displayName && b.password, 'handle_displayName_password_required')) return; if (one('SELECT id FROM users WHERE handle=?', b.handle)) return reply.code(409).send({ error: 'handle_taken' }); const id = makeId('usr'); const createdAt = now(); run('INSERT INTO users (id,handle,display_name,password,status,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)', id, b.handle, b.displayName, b.password, 'active', createdAt, createdAt); run('INSERT INTO settings (user_id) VALUES (?)', id); return { user: publicUser(one('SELECT * FROM users WHERE id=?', id)), tokens: { accessToken: jwt.sign({ sub: id, kind: 'user' }, secret, { expiresIn: '7d' }) } }; });
app.post('/api/v1/auth/login', async (request, reply) => { const b = request.body || {}; const user = one('SELECT * FROM users WHERE handle=? AND password=?', b.handle, b.password); if (!user) return reply.code(401).send({ error: 'invalid_credentials' }); if (user.status !== 'active') return reply.code(403).send({ error: 'user_inactive' }); run('UPDATE users SET last_seen_at=? WHERE id=?', now(), user.id); return { user: publicUser(user), tokens: { accessToken: jwt.sign({ sub: user.id, kind: 'user' }, secret, { expiresIn: '7d' }) } }; });
app.get('/api/v1/me', { preHandler: auth }, async (request, reply) => { const user = one('SELECT id,handle,display_name AS displayName,avatar_url AS avatarUrl,bio,status,created_at AS createdAt,last_seen_at AS lastSeenAt FROM users WHERE id=?', request.user.sub); return user ? publicUser(user) : reply.code(404).send({ error: 'user_not_found' }); });
app.patch('/api/v1/me', { preHandler: auth }, async (request) => { const b = request.body || {}; const user = one('SELECT * FROM users WHERE id=?', request.user.sub); const displayName = b.displayName ?? user.display_name; const avatarUrl = b.avatarUrl ?? user.avatar_url; const bio = b.bio ?? user.bio; run('UPDATE users SET display_name=?,avatar_url=?,bio=? WHERE id=?', displayName, avatarUrl, bio, user.id); return publicUser(one('SELECT * FROM users WHERE id=?', user.id)); });
app.get('/api/v1/me/appearance', { preHandler: auth }, async (request) => { const s = one('SELECT * FROM settings WHERE user_id=?', request.user.sub); return { glassMode: s.glass_mode, performanceProfile: s.performance_profile, pageTransition: s.page_transition, themeMode: s.theme_mode, reducedMotion: Boolean(s.reduced_motion) }; });
app.put('/api/v1/me/appearance', { preHandler: auth }, async (request, reply) => { const b = request.body || {}; const glassMode = b.glassMode || 'liquid_glass'; const performanceProfile = b.performanceProfile || 'full'; const pageTransition = b.pageTransition || 'shared_element'; if (!['liquid_glass','blur','none'].includes(glassMode) || !['full','balanced','reduced','off'].includes(performanceProfile) || !['shared_element','miuix','aosp','reduced_motion'].includes(pageTransition)) return reply.code(400).send({ error: 'invalid_appearance_value' }); run('UPDATE settings SET glass_mode=?,performance_profile=?,page_transition=?,theme_mode=?,reduced_motion=? WHERE user_id=?', glassMode, performanceProfile, pageTransition, b.themeMode || 'system', b.reducedMotion ? 1 : 0, request.user.sub); return { glassMode, performanceProfile, pageTransition, themeMode: b.themeMode || 'system', reducedMotion: Boolean(b.reducedMotion) }; });

app.get('/api/v1/users/search', { preHandler: auth }, async (request) => { const q = '%' + String(request.query.q || '') + '%'; return { items: all('SELECT id,handle,display_name AS displayName,avatar_url AS avatarUrl,bio,status,created_at AS createdAt,last_seen_at AS lastSeenAt FROM users WHERE id != ? AND (handle LIKE ? OR display_name LIKE ?) ORDER BY handle LIMIT 50', request.user.sub, q, q).map(publicUser) }; });
app.get('/api/v1/devices', { preHandler: auth }, async (request) => ({ items: all('SELECT id,device_name AS deviceName,platform,push_token AS pushToken,last_seen_at AS lastSeenAt,created_at AS createdAt FROM devices WHERE user_id=? ORDER BY last_seen_at DESC', request.user.sub) }));
app.post('/api/v1/devices', { preHandler: auth }, async (request, reply) => { const b = request.body || {}; if (requireBody(reply, b.deviceName && b.platform, 'deviceName_platform_required')) return; const id = makeId('dev'); const t = now(); run('INSERT INTO devices (id,user_id,device_name,platform,push_token,last_seen_at,created_at) VALUES (?,?,?,?,?,?,?)', id, request.user.sub, b.deviceName, b.platform, b.pushToken || null, t, t); return reply.code(201).send(one('SELECT id,device_name AS deviceName,platform,push_token AS pushToken,last_seen_at AS lastSeenAt,created_at AS createdAt FROM devices WHERE id=?', id)); });
app.delete('/api/v1/devices/:id', { preHandler: auth }, async (request, reply) => { const result = run('DELETE FROM devices WHERE id=? AND user_id=?', request.params.id, request.user.sub); return result.changes ? reply.code(204).send() : reply.code(404).send({ error: 'device_not_found' }); });

app.get('/api/v1/contacts', { preHandler: auth }, async (request) => ({ items: all('SELECT c.id,c.alias,c.status,c.created_at AS createdAt,u.id AS userId,u.handle,u.display_name AS displayName,u.avatar_url AS avatarUrl FROM contacts c JOIN users u ON u.id=c.contact_user_id WHERE c.user_id=? ORDER BY u.display_name', request.user.sub) }));
app.post('/api/v1/contacts', { preHandler: auth }, async (request, reply) => { const b = request.body || {}; if (requireBody(reply, b.userId, 'userId_required')) return; if (b.userId === request.user.sub || !one('SELECT id FROM users WHERE id=?', b.userId)) return reply.code(404).send({ error: 'user_not_found' }); const id = makeId('con'); try { run('INSERT INTO contacts (id,user_id,contact_user_id,alias,status,created_at) VALUES (?,?,?,?,?,?)', id, request.user.sub, b.userId, b.alias || null, 'accepted', now()); run('INSERT OR IGNORE INTO contacts (id,user_id,contact_user_id,status,created_at) VALUES (?,?,?,?,?)', makeId('con'), b.userId, request.user.sub, 'accepted', now()); } catch { return reply.code(409).send({ error: 'contact_exists' }); } return reply.code(201).send(one('SELECT id,alias,status,created_at AS createdAt FROM contacts WHERE id=?', id)); });
app.delete('/api/v1/contacts/:userId', { preHandler: auth }, async (request, reply) => { run('DELETE FROM contacts WHERE user_id=? AND contact_user_id=?', request.user.sub, request.params.userId); run('DELETE FROM contacts WHERE user_id=? AND contact_user_id=?', request.params.userId, request.user.sub); return reply.code(204).send(); });

app.get('/api/v1/conversations', { preHandler: auth }, async (request) => ({ items: all(`SELECT c.id,c.kind,c.title,c.created_at AS createdAt,c.updated_at AS updatedAt, (SELECT content FROM messages m WHERE m.conversation_id=c.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS lastMessage FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=? ORDER BY c.updated_at DESC`, request.user.sub) }));
app.post('/api/v1/conversations', { preHandler: auth }, async (request, reply) => { const b = request.body || {}; const members = [...new Set([request.user.sub, ...(Array.isArray(b.memberIds) ? b.memberIds : [])])]; if (members.length < 2 && b.kind !== 'self') return reply.code(400).send({ error: 'memberIds_required' }); if (members.some(id => !one('SELECT id FROM users WHERE id=?', id))) return reply.code(404).send({ error: 'member_not_found' }); const id = makeId('cv'); const t = now(); run('INSERT INTO conversations (id,kind,title,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)', id, b.kind || 'direct', b.title || null, request.user.sub, t, t); for (const memberId of members) run('INSERT INTO conversation_members (conversation_id,user_id,role,joined_at) VALUES (?,?,?,?)', id, memberId, memberId === request.user.sub ? 'owner' : 'member', t); return reply.code(201).send({ id, kind: b.kind || 'direct', title: b.title || null, memberIds: members, createdAt: t }); });
app.get('/api/v1/conversations/:id/messages', { preHandler: auth }, async (request, reply) => { if (!isMember(request.params.id, request.user.sub)) return reply.code(403).send({ error: 'conversation_access_denied' }); return { items: all('SELECT m.id,m.conversation_id AS conversationId,m.sender_id AS senderId,m.content,m.content_type AS contentType,m.attachment_id AS attachmentId,m.created_at AS createdAt,m.edited_at AS editedAt FROM messages m WHERE m.conversation_id=? AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 200', request.params.id) }; });
app.post('/api/v1/conversations/:id/messages', { preHandler: auth }, async (request, reply) => { if (!isMember(request.params.id, request.user.sub)) return reply.code(403).send({ error: 'conversation_access_denied' }); const b = request.body || {}; if (requireBody(reply, b.content || b.attachmentId, 'content_or_attachmentId_required')) return; const id = makeId('msg'); const t = now(); run('INSERT INTO messages (id,conversation_id,sender_id,content,content_type,attachment_id,created_at) VALUES (?,?,?,?,?,?,?)', id, request.params.id, request.user.sub, b.content || '', b.contentType || 'text', b.attachmentId || null, t); run('UPDATE conversations SET updated_at=? WHERE id=?', t, request.params.id); const message = one('SELECT id,conversation_id AS conversationId,sender_id AS senderId,content,content_type AS contentType,attachment_id AS attachmentId,created_at AS createdAt FROM messages WHERE id=?', id); publish(all('SELECT user_id FROM conversation_members WHERE conversation_id=?', request.params.id).map(row => row.user_id), 'message.created', message); return reply.code(201).send(message); });

app.get('/api/v1/moments', { preHandler: auth }, async () => ({ items: all('SELECT m.id,m.author_id AS authorId,m.content,m.visibility,m.created_at AS createdAt,u.handle,u.display_name AS displayName,u.avatar_url AS avatarUrl FROM moments m JOIN users u ON u.id=m.author_id WHERE m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 100') }));
app.post('/api/v1/moments', { preHandler: auth }, async (request, reply) => { const b = request.body || {}; if (requireBody(reply, b.content || (b.uploadIds && b.uploadIds.length), 'content_or_uploadIds_required')) return; const id = makeId('mom'); const t = now(); run('INSERT INTO moments (id,author_id,content,visibility,created_at) VALUES (?,?,?,?,?)', id, request.user.sub, b.content || '', b.visibility || 'contacts', t); for (const [sortOrder, uploadId] of (b.uploadIds || []).entries()) run('INSERT INTO moment_media (id,moment_id,upload_id,sort_order) VALUES (?,?,?,?)', makeId('mm'), id, uploadId, sortOrder); return reply.code(201).send({ id, authorId: request.user.sub, content: b.content || '', visibility: b.visibility || 'contacts', createdAt: t }); });
app.delete('/api/v1/moments/:id', { preHandler: auth }, async (request, reply) => { const r = run('UPDATE moments SET deleted_at=? WHERE id=? AND author_id=? AND deleted_at IS NULL', now(), request.params.id, request.user.sub); return r.changes ? reply.code(204).send() : reply.code(404).send({ error: 'moment_not_found' }); });

app.get('/api/v1/bottles', { preHandler: auth }, async () => ({ items: all("SELECT id,content,created_at AS createdAt FROM bottles WHERE status='drifting' ORDER BY created_at ASC LIMIT 20") }));
app.post('/api/v1/bottles', { preHandler: auth }, async (request, reply) => { const b = request.body || {}; if (requireBody(reply, b.content, 'content_required')) return; const id = makeId('bot'); const t = now(); run('INSERT INTO bottles (id,author_id,content,created_at) VALUES (?,?,?,?)', id, request.user.sub, b.content, t); return reply.code(201).send({ id, content: b.content, status: 'drifting', createdAt: t }); });
app.post('/api/v1/bottles/:id/pick', { preHandler: auth }, async (request, reply) => { const r = run("UPDATE bottles SET status='picked',picked_by=?,picked_at=? WHERE id=? AND status='drifting' AND author_id != ?", request.user.sub, now(), request.params.id, request.user.sub); return r.changes ? { id: request.params.id, status: 'picked' } : reply.code(409).send({ error: 'bottle_unavailable' }); });

const uploadUrls = (id) => ({ uploadUrl: `/api/v1/uploads/${id}/content`, contentUrl: `/api/v1/uploads/${id}/content` });
const uploadPath = (storageKey) => {
  if (!/^upl_[0-9a-f-]+\.bin$/i.test(storageKey)) return null;
  const filePath = path.resolve(uploadDir, storageKey);
  return filePath.startsWith(uploadDir + path.sep) ? filePath : null;
};
app.get('/api/v1/uploads', { preHandler: auth }, async (request) => ({ items: all('SELECT id,file_name AS fileName,mime_type AS mimeType,byte_size AS byteSize,storage_key AS storageKey,created_at AS createdAt FROM uploads WHERE user_id=? ORDER BY created_at DESC LIMIT 100', request.user.sub).map((upload) => ({ ...upload, ...uploadUrls(upload.id) })) }));
app.post('/api/v1/uploads/metadata', { preHandler: auth }, async (request, reply) => { const b = request.body || {}; if (requireBody(reply, b.fileName && b.mimeType, 'fileName_mimeType_required')) return; const id = makeId('upl'); const t = now(); const storageKey = `${id}.bin`; const byteSize = Number(b.byteSize || 0); run('INSERT INTO uploads (id,user_id,file_name,mime_type,byte_size,storage_key,created_at) VALUES (?,?,?,?,?,?,?)', id, request.user.sub, b.fileName, b.mimeType, byteSize, storageKey, t); return reply.code(201).send({ id, fileName: b.fileName, mimeType: b.mimeType, byteSize, storageKey, createdAt: t, ...uploadUrls(id) }); });
app.put('/api/v1/uploads/:id/content', { preHandler: auth }, async (request, reply) => { const upload = one('SELECT * FROM uploads WHERE id=? AND user_id=?', request.params.id, request.user.sub); if (!upload) return reply.code(404).send({ error: 'upload_not_found' }); const filePath = uploadPath(upload.storage_key); if (!filePath) return reply.code(500).send({ error: 'invalid_upload_storage' }); const body = request.body; if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: 'binary_body_required' }); fs.writeFileSync(filePath, body); run('UPDATE uploads SET byte_size=? WHERE id=?', body.length, upload.id); return { id: upload.id, byteSize: body.length, ...uploadUrls(upload.id) }; });
app.get('/api/v1/uploads/:id/content', { preHandler: auth }, async (request, reply) => { const upload = one('SELECT * FROM uploads WHERE id=? AND user_id=?', request.params.id, request.user.sub); if (!upload) return reply.code(404).send({ error: 'upload_not_found' }); const filePath = uploadPath(upload.storage_key); if (!filePath || !fs.existsSync(filePath)) return reply.code(404).send({ error: 'upload_content_not_found' }); reply.type(upload.mime_type); reply.header('Content-Length', fs.statSync(filePath).size); return reply.send(fs.createReadStream(filePath)); });

app.get('/api/v1/notifications', { preHandler: auth }, async (request) => ({ items: all('SELECT id,type,title,body,data_json AS dataJson,read_at AS readAt,created_at AS createdAt FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100', request.user.sub) }));
app.post('/api/v1/notifications/:id/read', { preHandler: auth }, async (request, reply) => { const r = run('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?', now(), request.params.id, request.user.sub); return r.changes ? { id: request.params.id, readAt: now() } : reply.code(404).send({ error: 'notification_not_found' }); });
app.post('/api/v1/reports', { preHandler: auth }, async (request, reply) => { const b = request.body || {}; if (requireBody(reply, b.targetType && b.targetId && b.reason, 'targetType_targetId_reason_required')) return; const id = makeId('rpt'); const t = now(); run('INSERT INTO reports (id,reporter_id,target_type,target_id,reason,details,created_at) VALUES (?,?,?,?,?,?,?)', id, request.user.sub, b.targetType, b.targetId, b.reason, b.details || null, t); return reply.code(201).send({ id, status: 'open', createdAt: t }); });

app.post('/api/admin/v1/auth/login', async (request, reply) => { const b = request.body || {}; const admin = one('SELECT id,handle,role FROM admins WHERE handle=? AND password=?', b.handle, b.password); if (!admin) return reply.code(401).send({ error: 'invalid_credentials' }); const token = jwt.sign({ sub: admin.id, handle: admin.handle, role: admin.role, kind: 'admin' }, secret, { expiresIn: '8h' }); reply.setCookie('suchat_admin_session', token, { httpOnly: true, sameSite: 'lax', path: '/' }); return { admin }; });
app.get('/api/admin/v1/me', { preHandler: adminGuard }, async (request) => ({ id: request.admin.sub, handle: request.admin.handle, role: request.admin.role }));
app.get('/api/admin/v1/dashboard', { preHandler: adminGuard }, async () => ({ users: { total: one('SELECT COUNT(*) AS total FROM users').total }, realtime: { connections: 0, onlineUsers: 0 }, content: { messagesToday: one("SELECT COUNT(*) AS total FROM messages WHERE created_at >= date('now')").total, momentsToday: one("SELECT COUNT(*) AS total FROM moments WHERE created_at >= date('now')").total, driftingBottles: one("SELECT COUNT(*) AS total FROM bottles WHERE status='drifting'").total, openReports: one("SELECT COUNT(*) AS total FROM reports WHERE status='open'").total }, storage: { databaseBytes: fs.statSync(path.join(dataDir, 'suchat.db')).size, uploadsBytes: uploadsBytes() } }));
app.get('/api/admin/v1/users', { preHandler: adminGuard }, async (request) => { const q = '%' + String(request.query.q || '') + '%'; return { items: all('SELECT id,handle,display_name AS displayName,avatar_url AS avatarUrl,status,created_at AS createdAt,last_seen_at AS lastSeenAt FROM users WHERE handle LIKE ? OR display_name LIKE ? ORDER BY created_at DESC LIMIT 100', q, q) }; });
app.get('/api/admin/v1/reports', { preHandler: adminGuard }, async () => ({ items: all('SELECT id,reporter_id AS reporterId,target_type AS targetType,target_id AS targetId,reason,details,status,reviewed_at AS reviewedAt,created_at AS createdAt FROM reports ORDER BY created_at DESC LIMIT 100') }));
app.patch('/api/admin/v1/reports/:id', { preHandler: adminGuard }, async (request, reply) => { const status = request.body?.status; if (!['open','reviewed','resolved','dismissed'].includes(status)) return reply.code(400).send({ error: 'invalid_report_status' }); const r = run('UPDATE reports SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?', status, request.admin.sub, now(), request.params.id); return r.changes ? { id: request.params.id, status } : reply.code(404).send({ error: 'report_not_found' }); });
app.get('/api/admin/v1/system/status', { preHandler: adminGuard }, async () => ({ server: { startedAt, uptimeSeconds: Math.round((Date.now() - startedMs) / 1000), version: '0.2.0' }, database: { path: 'data/suchat.db', sizeBytes: fs.statSync(path.join(dataDir, 'suchat.db')).size, integrity: one('PRAGMA integrity_check').integrity_check }, storage: { uploadsPath: 'data/uploads', sizeBytes: uploadsBytes() }, realtime: { connections: 0 } }));
app.get('/admin', async (_, reply) => reply.sendFile('index.html'));
const startedAt = now();
const startedMs = Date.now();
app.listen({ host, port }).then(() => console.log('Suchat Local Server ready: http://' + host + ':' + port));
