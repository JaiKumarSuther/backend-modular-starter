#!/usr/bin/env node
/**
 * backend-modular-starter
 * Author: Jai
 * Industry-ready modular Node.js backend CLI
 */

const inquirer = require("inquirer");
const fs = require("fs-extra");
const path = require("path");
const chalk = require("chalk");
const { execSync } = require("child_process");

// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════

const write = (filePath, content) => {
  fs.ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, content.trimStart());
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ══════════════════════════════════════════════════════════
//  TEMPLATES — APP.JS
// ══════════════════════════════════════════════════════════

const tplApp = (appName, sockets, database, redis) => {
  const dbImport =
    database === "MongoDB"
      ? `const connectDB = require('./config/db.config');`
      : database !== "None"
      ? `const db = require('./config/db.config');`
      : "";

  const redisImport = redis ? `const redisClient = require('./config/redis.config');` : "";

  const dbInit =
    database === "MongoDB"
      ? `\n// ── Database ──────────────────────────────────────────────\nconnectDB();`
      : database !== "None"
      ? `\n// ── Database ──────────────────────────────────────────────\ndb.query('SELECT 1')\n  .then(() => console.log('  ✅  DB connected'))\n  .catch((err) => { console.error('  ❌  DB error:', err.message); process.exit(1); });`
      : "";

  // BUG 6 FIX: Health check actually pings DB and Redis
  const healthDb =
    database !== "None" && database !== "MongoDB"
      ? `\n    await db.query('SELECT 1');`
      : database === "MongoDB"
      ? `\n    const { readyState } = require('mongoose').connection;\n    if (readyState !== 1) throw new Error('MongoDB not ready');`
      : "";

  const healthRedis = redis
    ? `\n    await redisClient.ping();`
    : "";

  // BUG 3 FIX: Separate strict rate limiter for auth routes (brute-force protection)
  return `const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger.config');
${dbImport}
${redisImport}
const authRoutes = require('./modules/auth/auth.route');
const userRoutes = require('./modules/user/user.route');

const app = express();
${dbInit}

// ── Request ID (correlation ID for log tracing) ────────────
app.use((req, _res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  next();
});

// ── Security ───────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));

// ── Body Parsing ───────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate Limiting — General API ────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Try again later.' },
  keyGenerator: (req) => req.ip,
});
app.use('/api', apiLimiter);

// ── Rate Limiting — Auth routes (brute-force protection) ───
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts. Try again in 15 minutes.' },
  keyGenerator: (req) => req.ip,
});
app.use('/api/auth', authLimiter);

// ── Swagger Docs ───────────────────────────────────────────
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: '${appName} API Docs',
}));

// ── Routes ─────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);

// ── Health Check (pings DB + Redis) ────────────────────────
app.get('/health', async (_req, res) => {
  try {
    ${healthDb || "// no DB configured"}${healthRedis || ""}
    res.status(200).json({ success: true, project: '${appName}', status: 'ok', timestamp: new Date() });
  } catch (err) {
    res.status(503).json({ success: false, status: 'degraded', message: err.message });
  }
});

// ── 404 Handler ────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ── Global Error Handler ───────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  // Don't leak stack traces in production
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);
  res.status(status).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { requestId: req.id }),
  });
});

module.exports = app;
`;
};

// ══════════════════════════════════════════════════════════
//  TEMPLATES — SERVER.JS
// ══════════════════════════════════════════════════════════

const tplServer = (appName, sockets, database, redis) => {
  const socketImports = sockets
    ? `const { Server } = require('socket.io');\nconst initSockets = require('./sockets');`
    : "";

  const socketSetup = sockets
    ? `\nconst io = new Server(server, {\n  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] },\n});\ninitSockets(io);\n`
    : "";

  const socketLog = sockets
    ? `\n  console.log(\`  🔌  Sockets:  http://localhost:\${PORT}\`);`
    : "";

  // BUG 4 FIX: Required env vars validated before server starts — fail fast
  const requiredEnv = ["JWT_SECRET"];
  if (database !== "None") requiredEnv.push("DATABASE_URL");
  if (database === "MongoDB") {
    requiredEnv.splice(requiredEnv.indexOf("DATABASE_URL"), 1);
    requiredEnv.push("MONGO_URI");
  }
  if (redis) requiredEnv.push("REDIS_URL");

  const envList = requiredEnv.map((e) => `'${e}'`).join(", ");

  // BUG 5 FIX: Graceful shutdown on SIGTERM / SIGINT
  const dbClose =
    database === "MongoDB"
      ? `\n    const mongoose = require('mongoose'); await mongoose.connection.close();`
      : database !== "None"
      ? `\n    const db = require('./config/db.config'); await db.end();`
      : "";

  const redisClose = redis
    ? `\n    const redis = require('./config/redis.config'); await redis.quit();`
    : "";

  return `require('dotenv').config();
const http = require('http');
const app = require('./app');
${socketImports}

// ── Env validation (fail fast) ─────────────────────────────
const REQUIRED_ENV = [${envList}];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(\`\\n  ❌  Missing required environment variables: \${missing.join(', ')}\\n  → Set them in .env before starting.\\n\`);
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
${socketSetup}
server.listen(PORT, () => {
  console.log('');
  console.log(\`  🚀  ${appName} is running!\`);
  console.log(\`  🌐  http://localhost:\${PORT}\`);
  console.log(\`  📄  Swagger:  http://localhost:\${PORT}/api-docs\`);${socketLog}
  console.log('');
});

// ── Graceful shutdown ──────────────────────────────────────
const shutdown = async (signal) => {
  console.log(\`\\n  ⚡  \${signal} received — shutting down gracefully...\`);
  server.close(async () => {
    try {
      ${dbClose}${redisClose}
      console.log('  ✅  Clean shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('  ❌  Error during shutdown:', err.message);
      process.exit(1);
    }
  });
  // Force-kill if graceful exit takes more than 10s
  setTimeout(() => { console.error('  ⚠️  Forced exit after timeout'); process.exit(1); }, 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (err) => { console.error('Uncaught exception:', err); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); process.exit(1); });
`;
};

// ══════════════════════════════════════════════════════════
//  TEMPLATES — CONFIG
// ══════════════════════════════════════════════════════════

const tplSwagger = (appName) => `const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: '${appName} API',
      version: '1.0.0',
      description: 'Auto-generated API documentation',
    },
    tags: [
      { name: 'Auth', description: 'Authentication endpoints' },
      { name: 'Users', description: 'User management endpoints' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  },
  apis: ['./src/modules/**/*.route.js'],
};

module.exports = swaggerJsdoc(options);
`;

const tplDbMongo = () => `const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('  ✅  MongoDB connected');
  } catch (err) {
    console.error('  ❌  MongoDB error:', err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
`;

const tplDbPostgres = () => `const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

pool.on('connect', () => console.log('  ✅  PostgreSQL connected'));
pool.on('error', (err) => {
  console.error('  ❌  PostgreSQL error:', err.message);
  process.exit(1);
});

module.exports = pool;
`;

const tplDbMySQL = () => `const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
});

console.log('  ✅  MySQL pool created');
module.exports = pool;
`;

const tplRedis = () => `const { createClient } = require('redis');

const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });

redisClient.on('error', (err) => console.error('  ❌  Redis error:', err.message));
redisClient.on('connect', () => console.log('  ✅  Redis connected'));
redisClient.on('reconnecting', () => console.warn('  ⚠️   Redis reconnecting...'));

(async () => {
  try { await redisClient.connect(); }
  catch (err) { console.error('  ❌  Redis connect failed:', err.message); }
})();

module.exports = redisClient;
`;

// ══════════════════════════════════════════════════════════
//  TEMPLATES — MIDDLEWARES
// ══════════════════════════════════════════════════════════

const tplAuthMiddleware = () => `const jwt = require('jsonwebtoken');

/**
 * Protect routes — verifies Bearer JWT
 */
const protect = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({ success: false, message: 'No token. Authorization denied.' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError'
      ? 'Token has expired. Please login again.'
      : 'Token invalid.';
    res.status(401).json({ success: false, message });
  }
};

/**
 * Restrict to specific roles
 * Usage: router.delete('/:id', protect, restrictTo('admin'))
 */
const restrictTo = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: 'You do not have permission for this action.' });
  }
  next();
};

module.exports = { protect, restrictTo };
`;

const tplErrorMiddleware = () => `/**
 * Async error wrapper — eliminates try/catch boilerplate in every controller
 * Usage: router.get('/', asyncHandler(controller.getAll))
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Custom operational error — status is sent to the client
 */
class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
    this.isOperational = true;
  }
}

module.exports = { asyncHandler, AppError };
`;

const tplValidateMiddleware = () => `/**
 * Generic request body validator
 * Works with any schema library that exposes a .validate(data) method (Joi, Yup, zod, etc.)
 *
 * Usage with Joi:
 *   const Joi = require('joi');
 *   const schema = Joi.object({ email: Joi.string().email().required() });
 *   router.post('/', validate(schema), controller.create);
 */
const validate = (schema) => (req, res, next) => {
  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    const messages = error.details.map((d) => d.message.replace(/['"]/g, ''));
    return res.status(422).json({ success: false, message: 'Validation failed', errors: messages });
  }
  next();
};

module.exports = validate;
`;

// ══════════════════════════════════════════════════════════
//  TEMPLATES — UTILS
// ══════════════════════════════════════════════════════════

const tplApiResponse = () => `/**
 * Standardised API response helpers — keeps all responses consistent
 */

/** 2xx success with optional data payload */
const success = (res, data = null, message = 'Success', statusCode = 200) =>
  res.status(statusCode).json({ success: true, message, data });

/** 4xx/5xx error response */
const error = (res, message = 'Something went wrong', statusCode = 500) =>
  res.status(statusCode).json({ success: false, message });

/** Paginated list response */
const paginate = (res, data, total, page, limit) =>
  res.status(200).json({
    success: true,
    data,
    pagination: {
      total: Number(total),
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / limit),
    },
  });

module.exports = { success, error, paginate };
`;

const tplLogger = () => `const { createLogger, format, transports } = require('winston');
const { combine, colorize, timestamp, printf, errors } = format;

const logFormat = printf(({ timestamp, level, message, stack }) =>
  \`[\${timestamp}] \${level}: \${stack || message}\`
);

const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
  format: combine(
    errors({ stack: true }),  // captures full stack traces
    colorize({ all: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'logs/error.log', level: 'error', format: format.uncolorize() }),
    new transports.File({ filename: 'logs/app.log', format: format.uncolorize() }),
  ],
  exceptionHandlers: [
    new transports.File({ filename: 'logs/exceptions.log' }),
  ],
});

module.exports = logger;
`;

const tplConstants = () => `module.exports = {
  ROLES: Object.freeze({ USER: 'user', ADMIN: 'admin' }),
  TOKEN_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  BCRYPT_ROUNDS: 12,
  PASSWORD_MIN_LEN: 8,
};
`;

// ══════════════════════════════════════════════════════════
//  TEMPLATES — USER MODULE
// ══════════════════════════════════════════════════════════

const tplUserSchema = (database) => {
  if (database === "MongoDB") {
    return `const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { BCRYPT_ROUNDS } = require('../../utils/constants');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: [50, 'Name must be under 50 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/\\S+@\\S+\\.\\S+/, 'Invalid email format'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
    },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    avatar: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, BCRYPT_ROUNDS);
  next();
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.model('User', userSchema);
`;
  }

  // ── BUG 1 FIX: findByIdWithPassword includes the password column for changePassword use ──
  // ── BUG 2 FIX: updateById converts camelCase keys → snake_case DB columns ──
  if (database === "PostgreSQL") {
    return `const pool = require('../../config/db.config');
const bcrypt = require('bcryptjs');
const { BCRYPT_ROUNDS } = require('../../utils/constants');

// ── Run once to create the table ──────────────────────────────
// CREATE TABLE IF NOT EXISTS users (
//   id            SERIAL PRIMARY KEY,
//   name          VARCHAR(50)  NOT NULL,
//   email         VARCHAR(255) NOT NULL UNIQUE,
//   password      VARCHAR(255) NOT NULL,
//   role          VARCHAR(10)  NOT NULL DEFAULT 'user',
//   avatar        TEXT,
//   is_active     BOOLEAN      NOT NULL DEFAULT true,
//   last_login_at TIMESTAMPTZ,
//   created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
//   updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
// );
// ──────────────────────────────────────────────────────────────

const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);
const comparePassword = (plain, hash) => bcrypt.compare(plain, hash);

// Convert camelCase JS keys to snake_case SQL columns
const toSnake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

const findByEmail = (email) =>
  pool.query('SELECT * FROM users WHERE email = $1 AND is_active = true', [email]);

// Public fields only — password NOT included
const findById = (id) =>
  pool.query(
    'SELECT id, name, email, role, avatar, is_active, last_login_at, created_at FROM users WHERE id = $1',
    [id]
  );

// BUG 1 FIX: Separate query that includes password hash — used only for auth checks
const findByIdWithPassword = (id) =>
  pool.query('SELECT * FROM users WHERE id = $1', [id]);

const create = async ({ name, email, password, role = 'user' }) => {
  const hashed = await hashPassword(password);
  const { rows } = await pool.query(
    'INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role, created_at',
    [name, email, hashed, role]
  );
  return rows[0];
};

const findAll = ({ limit = 10, offset = 0 } = {}) =>
  pool.query(
    'SELECT id, name, email, role, avatar, is_active, created_at FROM users WHERE is_active = true ORDER BY created_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );

const countAll = () =>
  pool.query('SELECT COUNT(*) FROM users WHERE is_active = true');

// BUG 2 FIX: Convert camelCase field names to snake_case before building SQL
const updateById = (id, fields) => {
  const entries = Object.entries(fields);
  const set = entries.map(([k], i) => \`\${toSnake(k)} = $\${i + 1}\`).join(', ');
  return pool.query(
    \`UPDATE users SET \${set}, updated_at = NOW() WHERE id = $\${entries.length + 1} RETURNING id, name, email, role, avatar\`,
    [...entries.map(([, v]) => v), id]
  );
};

const softDelete = (id) =>
  pool.query('UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1', [id]);

const updatePassword = async (id, newPassword) => {
  const hashed = await hashPassword(newPassword);
  return pool.query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hashed, id]);
};

module.exports = {
  findByEmail, findById, findByIdWithPassword, create,
  findAll, countAll, updateById, softDelete, updatePassword, comparePassword,
};
`;
  }

  if (database === "MySQL") {
    return `const pool = require('../../config/db.config');
const bcrypt = require('bcryptjs');
const { BCRYPT_ROUNDS } = require('../../utils/constants');

// ── Run once to create the table ──────────────────────────────
// CREATE TABLE IF NOT EXISTS users (
//   id            INT AUTO_INCREMENT PRIMARY KEY,
//   name          VARCHAR(50)  NOT NULL,
//   email         VARCHAR(255) NOT NULL UNIQUE,
//   password      VARCHAR(255) NOT NULL,
//   role          ENUM('user','admin') NOT NULL DEFAULT 'user',
//   avatar        TEXT,
//   is_active     TINYINT(1)   NOT NULL DEFAULT 1,
//   last_login_at DATETIME,
//   created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
//   updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
// );
// ──────────────────────────────────────────────────────────────

const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);
const comparePassword = (plain, hash) => bcrypt.compare(plain, hash);

const toSnake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

const findByEmail = (email) =>
  pool.execute('SELECT * FROM users WHERE email = ? AND is_active = 1', [email]);

const findById = (id) =>
  pool.execute(
    'SELECT id, name, email, role, avatar, is_active, last_login_at, created_at FROM users WHERE id = ?',
    [id]
  );

// BUG 1 FIX: Includes password — used only for changePassword auth checks
const findByIdWithPassword = (id) =>
  pool.execute('SELECT * FROM users WHERE id = ?', [id]);

const create = async ({ name, email, password, role = 'user' }) => {
  const hashed = await hashPassword(password);
  const [result] = await pool.execute(
    'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
    [name, email, hashed, role]
  );
  return { id: result.insertId, name, email, role };
};

const findAll = ({ limit = 10, offset = 0 } = {}) =>
  pool.execute(
    'SELECT id, name, email, role, avatar, is_active, created_at FROM users WHERE is_active = 1 ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [limit, offset]
  );

const countAll = () =>
  pool.execute('SELECT COUNT(*) as total FROM users WHERE is_active = 1');

// BUG 2 FIX: Convert camelCase field names to snake_case
const updateById = (id, fields) => {
  const entries = Object.entries(fields);
  const set = entries.map(([k]) => \`\${toSnake(k)} = ?\`).join(', ');
  return pool.execute(
    \`UPDATE users SET \${set} WHERE id = ?\`,
    [...entries.map(([, v]) => v), id]
  );
};

const softDelete = (id) =>
  pool.execute('UPDATE users SET is_active = 0 WHERE id = ?', [id]);

const updatePassword = async (id, newPassword) => {
  const hashed = await hashPassword(newPassword);
  return pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, id]);
};

module.exports = {
  findByEmail, findById, findByIdWithPassword, create,
  findAll, countAll, updateById, softDelete, updatePassword, comparePassword,
};
`;
  }

  return `// No database selected — add your own data layer here\nmodule.exports = {};\n`;
};

const tplUserService = (database) => {
  if (database === "MongoDB") {
    return `const User = require('./user.schema');
const { AppError } = require('../../middlewares/error.middleware');

const getAllUsers = async ({ page = 1, limit = 10 } = {}) => {
  const skip = (page - 1) * limit;
  const [users, total] = await Promise.all([
    User.find({ isActive: true }).select('-password').skip(skip).limit(Number(limit)).lean(),
    User.countDocuments({ isActive: true }),
  ]);
  return { users, total };
};

const getUserById = async (id) => {
  const user = await User.findById(id).select('-password').lean();
  if (!user) throw new AppError('User not found', 404);
  return user;
};

const updateUser = async (id, data) => {
  ['password', 'role', '_id'].forEach((f) => delete data[f]);
  const user = await User.findByIdAndUpdate(id, data, { new: true, runValidators: true }).select('-password').lean();
  if (!user) throw new AppError('User not found', 404);
  return user;
};

const deleteUser = async (id) => {
  const user = await User.findByIdAndUpdate(id, { isActive: false }, { new: true });
  if (!user) throw new AppError('User not found', 404);
  return { message: 'User deleted successfully' };
};

const changePassword = async (id, currentPassword, newPassword) => {
  const user = await User.findById(id).select('+password');
  if (!user) throw new AppError('User not found', 404);
  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) throw new AppError('Current password is incorrect', 400);
  user.password = newPassword;
  await user.save();
  return { message: 'Password changed successfully' };
};

module.exports = { getAllUsers, getUserById, updateUser, deleteUser, changePassword };
`;
  }

  // BUG 1 FIX: changePassword now uses findByIdWithPassword which includes the password column
  return `const UserModel = require('./user.schema');
const { AppError } = require('../../middlewares/error.middleware');

const extractRows  = (r) => r.rows  ?? r[0] ?? [];
const extractRow   = (r) => r.rows?.[0] ?? r[0]?.[0] ?? null;
const extractCount = (r) => Number(r.rows?.[0]?.count ?? r[0]?.[0]?.total ?? 0);

const getAllUsers = async ({ page = 1, limit = 10 } = {}) => {
  const offset = (page - 1) * limit;
  const [rowsResult, countResult] = await Promise.all([
    UserModel.findAll({ limit: Number(limit), offset }),
    UserModel.countAll(),
  ]);
  return { users: extractRows(rowsResult), total: extractCount(countResult) };
};

const getUserById = async (id) => {
  const user = extractRow(await UserModel.findById(id));
  if (!user) throw new AppError('User not found', 404);
  return user;
};

const updateUser = async (id, data) => {
  ['password', 'role', 'id'].forEach((f) => delete data[f]);
  if (!Object.keys(data).length) throw new AppError('No valid fields to update', 400);
  const user = extractRow(await UserModel.updateById(id, data));
  if (!user) throw new AppError('User not found', 404);
  return user;
};

const deleteUser = async (id) => {
  await UserModel.softDelete(id);
  return { message: 'User deleted successfully' };
};

// BUG 1 FIX: Use findByIdWithPassword so we actually have the hash to compare
const changePassword = async (id, currentPassword, newPassword) => {
  const user = extractRow(await UserModel.findByIdWithPassword(id));
  if (!user) throw new AppError('User not found', 404);
  const isMatch = await UserModel.comparePassword(currentPassword, user.password);
  if (!isMatch) throw new AppError('Current password is incorrect', 400);
  await UserModel.updatePassword(id, newPassword);
  return { message: 'Password changed successfully' };
};

module.exports = { getAllUsers, getUserById, updateUser, deleteUser, changePassword };
`;
};

const tplUserController = () => `const userService = require('./user.service');
const { asyncHandler } = require('../../middlewares/error.middleware');
const { success, paginate } = require('../../utils/apiResponse');

/** GET /api/users/me */
const getMe = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.user.id);
  success(res, user);
});

/** GET /api/users (admin only) */
const getAllUsers = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const { users, total } = await userService.getAllUsers({ page, limit });
  paginate(res, users, total, page, limit);
});

/** GET /api/users/:id */
const getUserById = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.id);
  success(res, user);
});

/** PUT /api/users/:id */
const updateUser = asyncHandler(async (req, res) => {
  const user = await userService.updateUser(req.params.id, req.body);
  success(res, user, 'User updated');
});

/** DELETE /api/users/:id (admin only) */
const deleteUser = asyncHandler(async (req, res) => {
  const result = await userService.deleteUser(req.params.id);
  success(res, null, result.message);
});

/** PUT /api/users/change-password */
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const result = await userService.changePassword(req.user.id, currentPassword, newPassword);
  success(res, null, result.message);
});

module.exports = { getMe, getAllUsers, getUserById, updateUser, deleteUser, changePassword };
`;

const tplUserRoute = () => `const express = require('express');
const router = express.Router();
const userController = require('./user.controller');
const { protect, restrictTo } = require('../../middlewares/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: Users
 *   description: User management
 */

/**
 * @swagger
 * /api/users/me:
 *   get:
 *     summary: Get my profile
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user's profile
 */
router.get('/me', protect, userController.getMe);

/**
 * @swagger
 * /api/users/change-password:
 *   put:
 *     summary: Change own password
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *                 minLength: 8
 */
router.put('/change-password', protect, userController.changePassword);

/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: Get all users (admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 */
router.get('/', protect, restrictTo('admin'), userController.getAllUsers);

/**
 * @swagger
 * /api/users/{id}:
 *   get:
 *     summary: Get user by ID
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/:id', protect, userController.getUserById);

/**
 * @swagger
 * /api/users/{id}:
 *   put:
 *     summary: Update user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 */
router.put('/:id', protect, userController.updateUser);

/**
 * @swagger
 * /api/users/{id}:
 *   delete:
 *     summary: Soft-delete user (admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id', protect, restrictTo('admin'), userController.deleteUser);

module.exports = router;
`;

// ══════════════════════════════════════════════════════════
//  TEMPLATES — AUTH MODULE
// ══════════════════════════════════════════════════════════

const tplAuthSchema = (database) => {
  if (database === "MongoDB") {
    return `// Refresh token storage for token rotation (optional — extend as needed)
const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    token:     { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    isRevoked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// MongoDB TTL index — auto-removes expired tokens
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
`;
  }

  return `// Auth uses the users table defined in user.schema.js
// Extend this file to add refresh token rotation.
//
// Optional SQL — run once for refresh token support:
//
// CREATE TABLE IF NOT EXISTS refresh_tokens (
//   id         ${database === "PostgreSQL" ? "SERIAL PRIMARY KEY" : "INT AUTO_INCREMENT PRIMARY KEY"},
//   user_id    ${database === "PostgreSQL" ? "INT NOT NULL REFERENCES users(id) ON DELETE CASCADE" : "INT NOT NULL"},
//   token      VARCHAR(512) NOT NULL UNIQUE,
//   expires_at ${database === "PostgreSQL" ? "TIMESTAMPTZ" : "DATETIME"} NOT NULL,
//   is_revoked BOOLEAN NOT NULL DEFAULT false,
//   created_at ${database === "PostgreSQL" ? "TIMESTAMPTZ NOT NULL DEFAULT NOW()" : "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP"}
// );

module.exports = {};
`;
};

// BUG 7 FIX: Auth service validates email format and password length before touching DB
const tplAuthService = (database) => {
  const signLine = `jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' })`;

  const validation = `
  // Input validation (fail before any DB query)
  if (!name?.trim() || name.trim().length < 2)
    throw new AppError('Name must be at least 2 characters', 400);
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email))
    throw new AppError('Invalid email address', 400);
  if (!password || password.length < 8)
    throw new AppError('Password must be at least 8 characters', 400);`;

  if (database === "MongoDB") {
    return `const jwt = require('jsonwebtoken');
const User = require('../user/user.schema');
const { AppError } = require('../../middlewares/error.middleware');

const signToken = (payload) => ${signLine};

const register = async ({ name, email, password }) => {
${validation}

  const exists = await User.findOne({ email: email.toLowerCase() });
  if (exists) throw new AppError('Email already in use', 409);

  const user = await User.create({ name: name.trim(), email: email.toLowerCase(), password });
  const token = signToken({ id: user._id, role: user.role });
  return { token, user: { id: user._id, name: user.name, email: user.email, role: user.role } };
};

const login = async ({ email, password }) => {
  if (!email || !password) throw new AppError('Email and password are required', 400);

  const user = await User.findOne({ email: email.toLowerCase(), isActive: true }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError('Invalid email or password', 401); // intentionally vague
  }
  user.lastLoginAt = new Date();
  await user.save({ validateBeforeSave: false });

  const token = signToken({ id: user._id, role: user.role });
  return { token, user: { id: user._id, name: user.name, email: user.email, role: user.role } };
};

const getAuthUser = async (userId) => {
  const user = await User.findById(userId).select('-password');
  if (!user || !user.isActive) throw new AppError('User not found', 404);
  return user;
};

module.exports = { register, login, getAuthUser };
`;
  }

  return `const jwt = require('jsonwebtoken');
const UserModel = require('../user/user.schema');
const { AppError } = require('../../middlewares/error.middleware');

const signToken = (payload) => ${signLine};
const extractRow = (r) => r.rows?.[0] ?? r[0]?.[0] ?? null;

const register = async ({ name, email, password }) => {
${validation}

  const existing = extractRow(await UserModel.findByEmail(email.toLowerCase()));
  if (existing) throw new AppError('Email already in use', 409);

  const user = await UserModel.create({ name: name.trim(), email: email.toLowerCase(), password });
  const token = signToken({ id: user.id, role: user.role });
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
};

const login = async ({ email, password }) => {
  if (!email || !password) throw new AppError('Email and password are required', 400);

  const user = extractRow(await UserModel.findByEmail(email.toLowerCase()));
  if (!user) throw new AppError('Invalid email or password', 401);
  const isMatch = await UserModel.comparePassword(password, user.password);
  if (!isMatch) throw new AppError('Invalid email or password', 401);

  const token = signToken({ id: user.id, role: user.role });
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
};

const getAuthUser = async (userId) => {
  const user = extractRow(await UserModel.findById(userId));
  if (!user) throw new AppError('User not found', 404);
  return user;
};

module.exports = { register, login, getAuthUser };
`;
};

const tplAuthController = () => `const authService = require('./auth.service');
const { asyncHandler } = require('../../middlewares/error.middleware');
const { success } = require('../../utils/apiResponse');

/** POST /api/auth/register */
const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  const data = await authService.register({ name, email, password });
  success(res, data, 'Registered successfully', 201);
});

/** POST /api/auth/login */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const data = await authService.login({ email, password });
  success(res, data, 'Login successful');
});

/** GET /api/auth/me */
const getMe = asyncHandler(async (req, res) => {
  const user = await authService.getAuthUser(req.user.id);
  success(res, user, 'Authenticated user');
});

/** POST /api/auth/logout — stateless JWT: client discards token */
const logout = asyncHandler(async (_req, res) => {
  success(res, null, 'Logged out successfully');
});

module.exports = { register, login, getMe, logout };
`;

const tplAuthRoute = () => `const express = require('express');
const router = express.Router();
const authController = require('./auth.controller');
const { protect } = require('../../middlewares/auth.middleware');

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication
 */

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 2
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 8
 *     responses:
 *       201:
 *         description: Registered successfully
 *       400:
 *         description: Validation error
 *       409:
 *         description: Email already in use
 */
router.post('/register', authController.register);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login and receive a JWT
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', authController.login);

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get current authenticated user
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user object
 *       401:
 *         description: Unauthorized
 */
router.get('/me', protect, authController.getMe);

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Logout (client discards JWT)
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 */
router.post('/logout', protect, authController.logout);

module.exports = router;
`;

// ══════════════════════════════════════════════════════════
//  TEMPLATES — SOCKETS
// ══════════════════════════════════════════════════════════

const tplSocketIndex = () => `const registerUserHandlers = require('./user.handler');
const registerChatHandlers = require('./chat.handler');

/**
 * Initialize all Socket.IO handlers
 * @param {import('socket.io').Server} io
 */
const initSockets = (io) => {
  io.on('connection', (socket) => {
    console.log(\`  🔌  Socket connected: \${socket.id}\`);

    registerUserHandlers(io, socket);
    registerChatHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      console.log(\`  🔌  Socket disconnected: \${socket.id} (\${reason})\`);
    });

    socket.on('error', (err) => {
      console.error(\`  ❌  Socket error [\${socket.id}]:\`, err.message);
    });
  });
};

module.exports = initSockets;
`;

const tplSocketUserHandler = () => `/**
 * User presence handlers
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
module.exports = (io, socket) => {
  socket.on('user:join', (userId) => {
    if (!userId) return;
    socket.join(\`user:\${userId}\`);
    socket.emit('user:joined', { userId });
  });

  socket.on('user:online', ({ userId } = {}) => {
    if (!userId) return;
    io.emit('user:online', { userId, timestamp: new Date() });
  });

  socket.on('user:offline', ({ userId } = {}) => {
    if (!userId) return;
    io.emit('user:offline', { userId, timestamp: new Date() });
  });
};
`;

const tplSocketChatHandler = () => `/**
 * Chat room handlers
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
module.exports = (io, socket) => {
  socket.on('chat:join', ({ roomId, userId } = {}) => {
    if (!roomId || !userId) return;
    socket.join(\`room:\${roomId}\`);
    socket.to(\`room:\${roomId}\`).emit('chat:user_joined', { userId, roomId });
  });

  socket.on('chat:leave', ({ roomId, userId } = {}) => {
    if (!roomId) return;
    socket.leave(\`room:\${roomId}\`);
    socket.to(\`room:\${roomId}\`).emit('chat:user_left', { userId, roomId });
  });

  socket.on('chat:send', ({ roomId, userId, message } = {}) => {
    if (!roomId || !message) return;
    io.to(\`room:\${roomId}\`).emit('chat:message', {
      userId, message, roomId, timestamp: new Date(),
    });
  });

  socket.on('chat:typing', ({ roomId, userId } = {}) => {
    if (!roomId) return;
    socket.to(\`room:\${roomId}\`).emit('chat:typing', { userId });
  });
};
`;

// ══════════════════════════════════════════════════════════
//  TEMPLATES — ENV / DOCKER / GITIGNORE / README
// ══════════════════════════════════════════════════════════

const tplEnv = (appName, database, redis) => {
  const slug = appName.toLowerCase().replace(/\s/g, "_");
  let env = `# ── App ─────────────────────────────────────────────────
NODE_ENV=development
PORT=3000
CORS_ORIGIN=*

# ── JWT ──────────────────────────────────────────────────
JWT_SECRET=replace_this_with_a_strong_32+_char_secret
JWT_EXPIRES_IN=7d
`;

  if (database === "MongoDB") {
    env += `
# ── MongoDB ──────────────────────────────────────────────
MONGO_URI=mongodb://localhost:27017/${slug}
`;
  } else if (database === "PostgreSQL") {
    env += `
# ── PostgreSQL ───────────────────────────────────────────
DATABASE_URL=postgresql://user:password@localhost:5432/${slug}
`;
  } else if (database === "MySQL") {
    env += `
# ── MySQL ────────────────────────────────────────────────
DATABASE_URL=mysql://user:password@localhost:3306/${slug}
`;
  }

  if (redis) {
    env += `
# ── Redis ────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379
`;
  }

  return env.trim();
};

const tplDockerfile = () => `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
`;

const tplDockerCompose = (database, redis) => {
  const serviceMap = { MongoDB: "mongo", PostgreSQL: "postgres", MySQL: "mysql" };
  const dbService = serviceMap[database];

  const dbBlock = {
    MongoDB: `
  mongo:
    image: mongo:7-jammy
    restart: unless-stopped
    ports:
      - "27017:27017"
    volumes:
      - mongo_data:/data/db`,
    PostgreSQL: `
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: password
      POSTGRES_DB: appdb
    volumes:
      - pg_data:/var/lib/postgresql/data`,
    MySQL: `
  mysql:
    image: mysql:8-debian
    restart: unless-stopped
    ports:
      - "3306:3306"
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: appdb
      MYSQL_USER: user
      MYSQL_PASSWORD: password
    volumes:
      - mysql_data:/var/lib/mysql`,
  }[database] || "";

  const redisBlock = redis
    ? `\n  redis:\n    image: redis:7-alpine\n    restart: unless-stopped\n    ports:\n      - "6379:6379"`
    : "";

  const deps = [
    database !== "None" ? `      - ${dbService}` : "",
    redis ? `      - redis` : "",
  ].filter(Boolean);
  const depends = deps.length ? `\n    depends_on:\n${deps.join("\n")}` : "";

  const volEntries = [
    database === "MongoDB"    ? "  mongo_data:" : "",
    database === "PostgreSQL" ? "  pg_data:"    : "",
    database === "MySQL"      ? "  mysql_data:" : "",
  ].filter(Boolean);
  const volumes = volEntries.length ? `\nvolumes:\n${volEntries.join("\n")}` : "";

  return `version: '3.9'

services:
  app:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      - .:/app
      - /app/node_modules${depends}
    command: npm run dev
${dbBlock}${redisBlock}
${volumes}`.trim();
};

const tplGitignore = () => `node_modules/
.env
.env.local
logs/
dist/
build/
*.log
.DS_Store
Thumbs.db
coverage/
.nyc_output/
`;

const tplReadme = (appName, database, redis, sockets, docker) => `# ${appName}

> Generated by **backend-modular-starter** ❤️ by Jai

## 🚀 Quick Start

\`\`\`bash
# 1. Fill in your credentials
cp .env.example .env

# 2. Install dependencies
npm install

# 3. Start dev server
npm run dev
\`\`\`

## 📄 API Docs
Swagger UI → **http://localhost:3000/api-docs**

## ✅ Health Check
\`GET /health\` — returns \`{ success, status, timestamp }\`

## 🗂️ Structure

\`\`\`
src/
├── app.js              # Express app
├── server.js           # Entry point (env check + graceful shutdown)
├── config/
│   ├── swagger.config.js
${database !== "None" ? "│   ├── db.config.js\n" : ""}${redis ? "│   └── redis.config.js\n" : ""}├── middlewares/
│   ├── auth.middleware.js      # JWT protect + restrictTo
│   ├── error.middleware.js     # asyncHandler + AppError
│   └── validate.middleware.js
├── modules/
│   ├── auth/  (schema · service · controller · route)
│   └── user/  (schema · service · controller · route)
${sockets ? "├── sockets/  (index · user.handler · chat.handler)\n" : ""}└── utils/  (apiResponse · logger · constants)
\`\`\`

## 🔐 Auth Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | \`/api/auth/register\` | — | Register (name ≥2, email valid, password ≥8) |
| POST | \`/api/auth/login\`    | — | Login → JWT |
| GET  | \`/api/auth/me\`       | 🔒 | Current user |
| POST | \`/api/auth/logout\`   | 🔒 | Logout |

## 👤 User Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET    | \`/api/users/me\`              | 🔒 | My profile |
| PUT    | \`/api/users/change-password\` | 🔒 | Change password |
| GET    | \`/api/users\`                 | 🔒 Admin | All users |
| GET    | \`/api/users/:id\`             | 🔒 | User by ID |
| PUT    | \`/api/users/:id\`             | 🔒 | Update user |
| DELETE | \`/api/users/:id\`             | 🔒 Admin | Soft delete |

## ⚙️ Stack

| Tool | Purpose |
|------|---------|
| Express.js | HTTP framework |
| Helmet | Security headers |
| express-rate-limit | Rate limiting (global + auth-specific) |
| Swagger UI | Auto-generated API docs |
| bcryptjs | Password hashing (12 rounds) |
| jsonwebtoken | JWT auth |
| winston | Structured logging |
${database !== "None" ? `| ${database} | Database |\n` : ""}${redis ? "| Redis | Caching / queues |\n" : ""}${sockets ? "| Socket.IO | Real-time events |\n" : ""}${docker ? "| Docker | Containerisation |\n" : ""}
## 🔐 Environment Variables

See \`.env.example\`. The server refuses to start if any required variable is missing.
${docker && database !== "None" ? "\n> **Docker Compose:** When running via `docker-compose up`, change the DB host in `.env` from `localhost` to the service name (`postgres`, `mongo`, or `mysql`) so the app container can reach the database." : ""}
`;

// ══════════════════════════════════════════════════════════
//  PACKAGE.JSON BUILDER
// ══════════════════════════════════════════════════════════

const buildPackageJson = (appName, database, redis, sockets) => {
  const deps = {
    express: "^4.19.2",
    helmet: "^7.1.0",
    cors: "^2.8.5",
    dotenv: "^16.4.5",
    "express-rate-limit": "^7.3.1",
    "swagger-ui-express": "^5.0.1",
    "swagger-jsdoc": "^6.2.8",
    bcryptjs: "^2.4.3",
    jsonwebtoken: "^9.0.2",
    winston: "^3.13.0",
    joi: "^17.13.3",
  };

  if (database === "MongoDB")    deps["mongoose"]  = "^8.4.0";
  if (database === "PostgreSQL") deps["pg"]        = "^8.12.0";
  if (database === "MySQL")      deps["mysql2"]    = "^3.9.7";
  if (redis)                     deps["redis"]     = "^4.6.14";
  if (sockets)                   deps["socket.io"] = "^4.7.5";

  return {
    name: appName.toLowerCase().replace(/\s+/g, "-"),
    version: "1.0.0",
    description: `${appName} — modular Node.js backend`,
    main: "src/server.js",
    scripts: {
      start: "node src/server.js",
      dev: "nodemon src/server.js",
    },
    author: "Jai",
    license: "MIT",
    dependencies: deps,
    devDependencies: { nodemon: "^3.1.3" },
  };
};

// ══════════════════════════════════════════════════════════
//  MAIN CLI
// ══════════════════════════════════════════════════════════

async function main() {
  console.log(chalk.bold.green("\n  ╔══════════════════════════════════════╗"));
  console.log(chalk.bold.green("  ║  backend-modular-starter  by Jai   ║"));
  console.log(chalk.bold.green("  ╚══════════════════════════════════════╝\n"));

  // No extra modules checkbox — auth + user are always auto-generated
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "appName",
      message: "Project name:",
      validate: (v) => (v.trim() ? true : "Project name cannot be empty"),
    },
    {
      type: "list",
      name: "database",
      message: "Which database?",
      choices: ["MongoDB", "PostgreSQL", "MySQL", "None"],
      default: "MongoDB",
    },
    {
      type: "confirm",
      name: "redis",
      message: "Include Redis (caching / queues)?",
      default: false,
    },
    {
      type: "confirm",
      name: "sockets",
      message: "Include Socket.IO (real-time events)?",
      default: false,
    },
    {
      type: "confirm",
      name: "docker",
      message: "Include Docker setup (Dockerfile + docker-compose)?",
      default: false,
    },
    {
      type: "confirm",
      name: "runInstall",
      message: "Run npm install now?",
      default: true,
    },
  ]);

  const { appName, database, redis, sockets, docker, runInstall } = answers;
  const root = path.join(process.cwd(), appName);

  if (fs.existsSync(root)) {
    console.log(chalk.red(`\n  ❌  Folder "${appName}" already exists.\n`));
    process.exit(1);
  }

  console.log(chalk.yellow("\n  📁  Scaffolding project...\n"));

  // ── Directory skeleton ─────────────────────────────────
  [
    "src/config",
    "src/middlewares",
    "src/modules/auth",
    "src/modules/user",
    "src/utils",
    "logs",
    ...(sockets ? ["src/sockets"] : []),
  ].forEach((d) => fs.ensureDirSync(path.join(root, d)));

  // ── App & Server ───────────────────────────────────────
  write(path.join(root, "src/app.js"),    tplApp(appName, sockets, database, redis));
  write(path.join(root, "src/server.js"), tplServer(appName, sockets, database, redis));

  // ── Config ─────────────────────────────────────────────
  write(path.join(root, "src/config/swagger.config.js"), tplSwagger(appName));
  if (database === "MongoDB")    write(path.join(root, "src/config/db.config.js"), tplDbMongo());
  if (database === "PostgreSQL") write(path.join(root, "src/config/db.config.js"), tplDbPostgres());
  if (database === "MySQL")      write(path.join(root, "src/config/db.config.js"), tplDbMySQL());
  if (redis)  write(path.join(root, "src/config/redis.config.js"), tplRedis());

  // ── Middlewares ────────────────────────────────────────
  write(path.join(root, "src/middlewares/auth.middleware.js"),     tplAuthMiddleware());
  write(path.join(root, "src/middlewares/error.middleware.js"),    tplErrorMiddleware());
  write(path.join(root, "src/middlewares/validate.middleware.js"), tplValidateMiddleware());

  // ── Utils ──────────────────────────────────────────────
  write(path.join(root, "src/utils/apiResponse.js"), tplApiResponse());
  write(path.join(root, "src/utils/logger.js"),      tplLogger());
  write(path.join(root, "src/utils/constants.js"),   tplConstants());

  // ── Auth module (always generated) ────────────────────
  write(path.join(root, "src/modules/auth/auth.schema.js"),     tplAuthSchema(database));
  write(path.join(root, "src/modules/auth/auth.service.js"),    tplAuthService(database));
  write(path.join(root, "src/modules/auth/auth.controller.js"), tplAuthController());
  write(path.join(root, "src/modules/auth/auth.route.js"),      tplAuthRoute());

  // ── User module (always generated) ────────────────────
  write(path.join(root, "src/modules/user/user.schema.js"),     tplUserSchema(database));
  write(path.join(root, "src/modules/user/user.service.js"),    tplUserService(database));
  write(path.join(root, "src/modules/user/user.controller.js"), tplUserController());
  write(path.join(root, "src/modules/user/user.route.js"),      tplUserRoute());

  // ── Sockets ────────────────────────────────────────────
  if (sockets) {
    write(path.join(root, "src/sockets/index.js"),        tplSocketIndex());
    write(path.join(root, "src/sockets/user.handler.js"), tplSocketUserHandler());
    write(path.join(root, "src/sockets/chat.handler.js"), tplSocketChatHandler());
  }

  // ── Root files ─────────────────────────────────────────
  write(path.join(root, ".env"),         tplEnv(appName, database, redis));
  write(path.join(root, ".env.example"), tplEnv(appName, database, redis));
  write(path.join(root, ".gitignore"),   tplGitignore());
  write(
    path.join(root, "package.json"),
    JSON.stringify(buildPackageJson(appName, database, redis, sockets), null, 2)
  );
  write(path.join(root, "README.md"), tplReadme(appName, database, redis, sockets, docker));

  if (docker) {
    write(path.join(root, "Dockerfile"),         tplDockerfile());
    write(path.join(root, "docker-compose.yml"), tplDockerCompose(database, redis));
  }

  // ── Git init ───────────────────────────────────────────
  console.log(chalk.cyan("  🔧  Initialising git..."));
  try {
    execSync("git init", { cwd: root, stdio: "ignore" });
    execSync('git add . && git commit -m "chore: initial commit by backend-modular-starter"', {
      cwd: root,
      stdio: "ignore",
    });
    console.log(chalk.green("  ✅  Git initialised"));
  } catch {
    console.log(chalk.gray("  ⚠️   Git skipped (not installed)"));
  }

  // ── npm install ────────────────────────────────────────
  if (runInstall) {
    console.log(chalk.cyan("\n  📦  Installing dependencies...\n"));
    try {
      execSync("npm install", { cwd: root, stdio: "inherit" });
      console.log(chalk.green("\n  ✅  Dependencies installed"));
    } catch {
      console.log(chalk.red(`\n  ❌  npm install failed — run it manually:\n      cd ${appName} && npm install`));
    }
  }

  // ── Done ───────────────────────────────────────────────
  console.log(chalk.bold.green(`\n  🎉  "${appName}" is ready!\n`));
  console.log("  Next steps:\n");
  console.log(chalk.white(`    cd ${appName}`));
  console.log(chalk.white(`    # Fill in .env with your real credentials`));
  if (!runInstall) console.log(chalk.white(`    npm install`));
  console.log(chalk.white(`    npm run dev\n`));
  console.log(chalk.cyan(`  📄  Swagger: http://localhost:3000/api-docs`));
  console.log(chalk.cyan(`  ❤️   Happy coding, Jai!\n`));
}

main().catch((err) => {
  console.error(chalk.red("\n  ❌  Error:"), err.message);
  process.exit(1);
});
